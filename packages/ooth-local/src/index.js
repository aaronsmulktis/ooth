const { hashSync, compareSync, genSaltSync } = require('bcrypt-nodejs')
const { randomBytes } = require('crypto')
const LocalStrategy = require('passport-local').Strategy
const nodeify = require('nodeify')

const SALT_ROUNDS = 10

const tests = {
    username: {
        regex: /^[a-z][0-9a-z_]{3,19}$/,
        error: 'Username must be all lowercase, contain only letters, numbers and _ (starting with a letter), and be between 4 and 20 characters long.',
    },
    password: {
        test: (password) => /\d/.test(password) && /[a-z]/.test(password) && /[A-Z]/.test(password) && /.{6,}/.test(password),
        error: 'Password must contain digits, lowercase and uppercase letters and be at least 6 characters long.',
    },
}

function testValue(key, value) {
    const test = tests[key]
    if (test.regex) {
        if (!test.regex.test(value)) {
            throw new Error(test.error)
        }
    } else {
        if (!test.test(value)) {
            throw new Error(test.error)
        }
    }
}

function randomToken() {
    return randomBytes(43).toString('hex')
}

function nodeifyAsync(asyncFunction) {
    return function(...args) {
        return nodeify(asyncFunction(...args.slice(0, -1)), args[args.length - 1])
    }
}

function hash(pass) {
    return hashSync(pass, genSaltSync(SALT_ROUNDS))
}

module.exports = function({
    onRegister,
    onGenerateVerificationToken,
    onSendVerificationEmail,
    onVerify,
    onForgotPassword,
    onResetPassword,
    onChangePassword
}) {
    return function({
        name,
        registerPassportMethod,
        registerMethod,
        registerUniqueField,
        registerProfileField,
        getProfile,
        getUserByUniqueField,
        getUserById,
        getUserByFields,
        updateUser,
        insertUser,
        requireLogged,
        requireNotLogged,
        requireNotRegistered,
        requireRegisteredWithThis
    }) {

        registerUniqueField('username', 'username')
        registerUniqueField('email', 'email')
        registerProfileField('username')
        registerProfileField('email')
        registerProfileField('verified')

        registerPassportMethod('login', requireNotLogged, new LocalStrategy({
            usernameField: 'username',
            passwordField: 'password'
        }, nodeifyAsync((username, password) => {
            return getUserByUniqueField('username', username)
                .then(user => {
                    if (!user) {
                        return getUserByUniqueField('email', username)
                    } else {
                        return user
                    }
                }).then(user => {
                    if (!user) {
                        throw new Error('Incorrect email or username.')
                    }

                    if (!compareSync(password, user[name].password)) {
                        throw new Error('Incorrect password.')
                    }

                    return user
                })
        })))

        registerMethod('set-username', requireLogged, function(req, res) {
            const { username } = req.body

            if (typeof username !== 'string') {
                throw new Error('Invalid username')
            }

            testValue('username', username)

            return getUserByUniqueField('username', username)
                .then(user => {
                    if (user) {
                        throw new Error('This username is already registered.')
                    }

                    updateUser(req.user._id, {
                        username
                    }).then(() => {
                        return getUserById(req.user._id)
                    }).then(user => {
                        return res.send({
                            message: 'Username updated.',
                            user: getProfile(user)
                        })
                    })
                })
        })

        registerMethod('register', requireNotLogged, function(req, res) {
            const { email, password } = req.body

            if (typeof email !== 'string') {
                throw new Error('Invalid email')
            }
            if (typeof password !== 'string') {
                throw new Error('Invalid password')
            }

            testValue('password', password)

            return getUserByUniqueField('email', email)
                .then(user => {
                    if (user) {
                        throw new Error('This email is already registered.')
                    }

                    const verificationToken = randomToken()

                    insertUser({
                        email,
                        password: hash(password),
                        verificationToken
                    }).then(_id => {
                        if (onRegister) {
                            onRegister({
                                _id,
                                email,
                                verificationToken
                            })
                        }
                    })

                    res.send({
                        message: 'User registered successfully.'
                    })
                })
        })

        registerMethod('generate-verification-token', requireRegisteredWithThis, function(req, res) {
            const verificationToken = randomToken()

            const user = req.user

            updateUser(req.user._id, {
                verificationToken
            }).then(() => {
                if (onGenerateVerificationToken) {
                    onGenerateVerificationToken({
                        _id: user._id,
                        email: user[name].email,
                        verificationToken
                    })
                }

                res.send({
                    message: 'Message token generated'
                })
            })
        })

        registerMethod('verify', function(req, res) {
            if (!req.body.token) {
                throw new Error('Verification token required.')
            }

            return getUserByFields({
                verificationToken: req.body.token
            }).then(user => {
                if (!user) {
                    throw new Error('Verification token invalid, expired or already used.')
                }

                return updateUser(user._id, {
                    verified: true,
                    verificationToken: null
                }).then(() => {
                    return getUserById(user._id)
                }).then(user => {
                    if (onVerify) {
                        onVerify({
                            _id: user._id,
                            email: user[name].email
                        })
                    }

                    return res.send({
                        message: 'Email verified',
                        user: getProfile(user)
                    })
                })
            })
        })

        registerMethod('forgot-password', requireNotLogged, function(req, res) {
            const { username } = req.body

            if (!username || typeof username !== 'string') {
                throw new Error('Invalid username or email.')
            }

            return getUserByUniqueField('username', username)
                .then(user => {
                    if (!user) {
                        return getUserByUniqueField('email', username)
                    }
                }).then(user => {
                    if (!user) {
                        throw new Error('Invalid username or email.')
                    }

                    const passwordResetToken = randomToken()

                    updateUser(user._id, {
                        passwordResetToken
                    }).then(() => {

                        if (onForgotPassword) {
                            onForgotPassword({
                                _id: user._id,
                                email: user[name].email,
                                passwordResetToken
                            })

                        }

                        return res.send({
                            message: 'Password reset token generated'
                        })
                    })
                })
        })

        registerMethod('reset-password', requireNotLogged, function(req, res) {
            const { token, newPassword } = req.body
            if (!newPassword || !typeof newPassword === 'string') {
                throw new Error('Invalid password.')
            }

            testValue('password', password)

            return getUserByFields({
                passwordResetToken: token
            }).then(user => {
                if (!user) {
                    throw new Error('Invalid password reset token.')
                }
                updateUser(user._id, {
                    passwordResetToken: null,
                    password: hash(newPassword)
                }).then(() => {
                    if (onResetPassword) {
                        onResetPassword({
                            _id: user._id,
                            email: user[name].email
                        })
                    }
                    return res.send({
                        message: 'Password has been reset.'
                    })
                })
            })
        })

        registerMethod('change-password', requireLogged, function(req, res) {
            const { password, newPassword } = req.body

            if (!typeof password === 'string') {
                throw new Error('Invalid password.')
            }

            testValue('password', password)

            return getUserById(req.user._id)
                .then(user => {
                    if (!compareSync(password, user[name].password)) {
                        throw new Error('Incorrect password.')
                    }

                    updateUser(user._id, {
                        passwordResetToken: null,
                        password: hash(newPassword)
                    }).then(() => {
                        if (onChangePassword) {
                            onChangePassword({
                                _id: user._id,
                                email: user[name].email
                            })
                        }
                        return res.send({
                            message: 'Password has been changed.'
                        })
                    })
                })
        })

    }
}