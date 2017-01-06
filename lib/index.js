'use strict';

/**
 * A HAPI plugin for easy last-modified (and potentially etag) caching.
 *
 * To use, add the following to your hapi route config
 *
 * <pre>
 *     plugins: {
 *         warp: {
 *              lastModified: function(req, cb) {
 *                  // compute what the last modified time would be of the response
 *                  // e.g. select max(updatedAt) from some_table where foo = req.params.blah
 *              }
 *         }
 *     },
 *     handler: function(req, reply) {
 *         console.log(req.plugins.warp.lastModified); // the last modified time is available to the handler if needed
 *     }
 * </pre>
 *
 * If enabled, warp will potentially short-circuit the route handler if the browser's if-modified-since header is the
 * the same as (or greater than) the computed last modified time.
 *
 * Warp will also apply the last modified header to the response for you.
 *
 * @type {{}}
 */

var internals = {};

internals.secondBoundary = function secondBoundary (date) {
    if (date) {
        date.setMilliseconds(0);
    }
    return date;
};

internals.isValidDate = function isValidDate (d) {
    return d && d.getTime() !== 0 && !isNaN(d.getTime());
};

internals.get = function (object, path) {
    return path.reduce(function (acc, path) {
        return acc && acc[path];
    }, object);
};

exports.register = function (server, opts, next) {
    var enabled = !!opts.enabled;

    server.ext('onPreHandler', function (req, reply) {
        var warp = req.route.settings.plugins.warp;

        // route isnt set up for warp
        if (!warp) return reply.continue();

        req.plugins.warp = {};

        if (warp.lastModified) {
            var lastModified = typeof warp.lastModified === 'string' ? internals.get(server.methods, warp.lastModified.split('.')) : warp.lastModified;
            lastModified(req, function (err, lastModified) {
                if (err) return reply(err);

                // sequelize will parse aggregate nulls into an invalid Date object
                if (!internals.isValidDate(lastModified)) return reply.continue();

                // stuff the last modified time in the request in case the handler needs it, regardless if the plugin
                // is enabled
                req.plugins.warp.lastModified = lastModified;

                // dont take over if warp is not enabled
                if (enabled && req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= internals.secondBoundary(lastModified)) {
                    reply().code(304).takeover();
                } else {
                    reply.continue();
                }
            });
        }

        else if (warp.etag) {
            warp.etag(req)
                .then(etag => {
                    req.plugins.warp.etag = etag;
                    if (enabled && req.headers['if-none-match'] === etag) return reply().code(304).takeover();

                    reply.continue();
                })
                .catch(() => reply.continue());
        }

        else {
            reply.continue();
        }
    });

    server.ext('onPostHandler', function (req, reply) {
        // no need to decorate an error response with last modified header
        if (req.response instanceof Error) return reply.continue();

        if (enabled && req.plugins.warp && (req.plugins.warp.lastModified || req.plugins.warp.etag) && !req.response.error) {

            // only set the header on the way out if the plugin is enabled
            req.response.header('last-modified', req.plugins.warp.lastModified);
            req.response.header('etag', req.plugins.warp.etag);

        } else if (!opts.enabled && req.response.headers) {

            // otherwise delete the header to prevent tricky dev-mode bugs
            delete req.response.headers['last-modified'];
            delete req.response.headers['etag'];
        }
        reply.continue();
    });

    next();
};

exports.register.attributes = { pkg: require('../package.json') };