/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

var express =  require('express');
var fs =       require('fs');
var Stream =   require('stream');
var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils
var terminal = require(__dirname + '/lib/web-terminal');
var path =     require('path');

var session;// =           require('express-session');
var cookieParser;// =      require('cookie-parser');
var bodyParser;// =        require('body-parser');
var AdapterStore;// =      require(__dirname + '/../../lib/session.js')(session);
var passportSocketIo;// =  require(__dirname + "/lib/passport.socketio.js");
var password;// =          require(__dirname + '/../../lib/password.js');
var passport;// =          require('passport');
var LocalStrategy;// =     require('passport-local').Strategy;
var flash;// =             require('connect-flash'); // TODO report error to user

var webServer =  null;
var store =      null;
var secret =     'Zgfr56gFe87jJOM'; // Will be generated by first start
var socketUrl =  '';
var cache =      {}; // cached web files
var ownSocket =  false;
var lang =       'en';

var adapter = utils.adapter({
    name: 'terminal',
    install: function (callback) {
        if (typeof callback === 'function') callback();
    },
    unload: function (callback) {
        try {
            adapter.log.info("terminating http" + (webServer.settings.secure ? "s" : "") + " server on port " + webServer.settings.port);
            webServer.server.close();
            adapter.log.info("terminated http" + (webServer.settings.secure ? "s" : "") + " server on port " + webServer.settings.port);

            callback();
        } catch (e) {
            callback();
        }
    },
    ready: function () {
        // Generate secret for session manager
        adapter.getForeignObject('system.adapter.terminal', function (err, obj) {
            if (!err && obj) {
                if (!obj.native.secret) {
                    require('crypto').randomBytes(24, function (ex, buf) {
                        secret = buf.toString('hex');
                        adapter.extendForeignObject('system.adapter.terminal', {native: {secret: secret}});
                        main();
                    });
                } else {
                    secret = obj.native.secret;
                    main();
                }
            } else {
                adapter.logger.error("Cannot find object system.adapter.terminal");
            }
        });

        // information about connected socket.io adapter
        if (adapter.config.socketio && adapter.config.socketio.match(/^system\.adapter\./)) {
            adapter.getForeignObject(adapter.config.socketio, function (err, obj) {
                if (obj && obj.common && obj.common.enabled && obj.native) socketUrl = ':' + obj.native.port;
            });
            // Listen for changes
            adapter.subscribeForeignObjects(adapter.config.socketio);
        } else {
            socketUrl = adapter.config.socketio;
            ownSocket = (socketUrl != 'none');
        }

        // Read language
        adapter.getForeignObject('system.config', function (err, data) {
            if (data && data.common) lang = data.common.language || 'en';
        });
    }
});

function main() {
    if (adapter.config.secure) {
        // Load certificates
        adapter.getForeignObject('system.certificates', function (err, obj) {
            if (err || !obj ||
                !obj.native.certificates ||
                !adapter.config.certPublic ||
                !adapter.config.certPrivate ||
                !obj.native.certificates[adapter.config.certPublic] ||
                !obj.native.certificates[adapter.config.certPrivate]
                ) {
                adapter.log.error('Cannot enable secure terminal server, because no certificates found: ' + adapter.config.certPublic + ', ' + adapter.config.certPrivate);
            } else {
                adapter.config.certificates = {
                    key:  obj.native.certificates[adapter.config.certPrivate],
                    cert: obj.native.certificates[adapter.config.certPublic]
                };

            }
            webServer = initWebServer(adapter.config);
        });
    } else {
        webServer = initWebServer(adapter.config);
    }
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//    "cache":  false
//}
function initWebServer(settings) {

    var server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };

    adapter.config.defaultUser = adapter.config.defaultUser || 'admin';

    if (settings.port) {
        if (settings.secure) {
            if (!adapter.config.certificates) {
                return null;
            }
        }
        server.app = express();
        if (settings.auth) {
            session =          require('express-session');
            cookieParser =     require('cookie-parser');
            bodyParser =       require('body-parser');
            AdapterStore =     require(utils.controllerDir + '/lib/session.js')(session);
            passportSocketIo = require(__dirname + '/lib/passport.socketio.js');
            password =         require(utils.controllerDir + '/lib/password.js');
            passport =         require('passport');
            LocalStrategy =    require('passport-local').Strategy;
            flash =            require('connect-flash'); // TODO report error to user

            store = new AdapterStore({adapter: adapter});

            passport.use(new LocalStrategy(
                function (username, password, done) {
                    adapter.checkPassword(username, password, function (res) {
                        if (res) {
                            return done(null, username);
                        } else {
                            return done(null, false);
                        }
                    });
                }
            ));
            passport.serializeUser(function (user, done) {
                done(null, user);
            });

            passport.deserializeUser(function (user, done) {
                done(null, user);
            });

            server.app.use(cookieParser());
            server.app.use(bodyParser.urlencoded({
                extended: true
            }));
            server.app.use(bodyParser.json());
            server.app.use(session({
                secret:            secret,
                saveUninitialized: true,
                resave:            true,
                store:             store
            }));
            server.app.use(passport.initialize());
            server.app.use(passport.session());
            server.app.use(flash());

            server.app.post('/login', function (req, res) {
                var redirect = '/';
                var parts;
                if (req.body.origin) {
                    parts = req.body.origin.split('=');
                    if (parts[1]) redirect = decodeURIComponent(parts[1]);
                }
                if (req.body && req.body.username && adapter.config.addUserName && redirect.indexOf('?') == -1) {
                    parts = redirect.split('#');
                    parts[0] += '?' + req.body.username;
                    redirect = parts.join('#');
                }
                var authenticate = passport.authenticate('local', {
                    successRedirect: redirect,
                    failureRedirect: '/login/index.html' + req.body.origin + (req.body.origin ? '&error' : '?error'),
                    failureFlash: 'Invalid username or password.'
                })(req, res);
            });

            server.app.get('/logout', function (req, res) {
                req.logout();
                res.redirect('/login/index.html');
            });

            // route middleware to make sure a user is logged in
            server.app.use(function (req, res, next) {
                if (req.isAuthenticated() ||
                    /^\/login\//.test(req.originalUrl) ||
                    /\.ico$/.test(req.originalUrl)
                ) return next();
                res.redirect('/login/index.html?href=' + encodeURIComponent(req.originalUrl));
            });
        } else {
            server.app.get('/login', function (req, res) {
                res.redirect('/');
            });
            server.app.get('/logout', function (req, res) {
                res.redirect('/');
            });
        }

        var appOptions = {};
        if (settings.cache) appOptions.maxAge = 30758400000;

        // deliver web files from objectDB
        server.app.use('/', function (req, res) {
            var url = decodeURI(req.url);

            if (server.api && server.api.checkRequest(url)) {
                server.api.restApi(req, res);
                return;
            }

            // add index.html
            url = url.replace(/\/($|\?|#)/, '/index.html$1');

            if (url.indexOf('login/index.html') != -1) {
                var buffer = fs.readFileSync(__dirname + '/www/login/index.html');
                if (buffer === null || buffer === undefined) {
                    res.contentType('text/html');
                    res.send('File ' + url + ' not found', 404);
                } else {
                    // Store file in cache
                    res.contentType('text/html');
                    res.send(buffer.toString());
                }
            } else {
                url = url.replace(/\?.*/, '');
                if (url == '/main.css' && adapter.config.style) {
                    url = '/main' + adapter.config.style + '.css';
                }
                if (fs.existsSync(__dirname + '/lib/web-terminal/web' + url)) {
                    if (url.match(/\.css$/))  {
                        res.contentType('text/css');
                    } else if (url.match(/\.js$/))  {
                        res.contentType('text/javascript');
                    } else if (url.match(/\.ico$/))  {
                        res.contentType('image/ico');
                    } else if (url.match(/\.png$/))  {
                        res.contentType('image/png');
                    } else {
                        res.contentType('text/html');
                    }
                    res.send(fs.readFileSync(__dirname + '/lib/web-terminal/web' + url).toString());
                } else {
                    res.contentType('text/html');
                    res.send('File ' + url + ' not found', 404);
                }
            }
        });

        if (settings.secure) {
            server.server = require('https').createServer(adapter.config.certificates, server.app);
        } else {
            server.server = require('http').createServer(server.app);
        }
        server.server.__server = server;
    } else {
        adapter.log.error('port missing');
        process.exit(1);
    }

    if (server.server) {
        adapter.getPort(settings.port, function (port) {
            if (port != settings.port && !adapter.config.findNextPort) {
                adapter.log.error('port ' + settings.port + ' already in use');
                process.exit(1);
            }
            server.server.listen(port);
            adapter.log.info('http' + (settings.secure ? 's' : '') + ' server listening on port ' + port);
        });

        /*server.app.use(function (req, res, next) {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, *');

            // intercept OPTIONS method
            if ('OPTIONS' == req.method) {
                res.send(200);
            } else {
                next();
            }
        });*/
        var config = {
            cwd: path.normalize(__dirname + '/../..')
        };

        terminal(server.server, config);
    }

    if (server.server) {
        return server;
    } else {
        return null;
    }
}
