var $ = require('jQuery');
var Q = require('Q');

if (typeof(window) == 'undefined') {
    webgl = require('node-webgl');
    Image = webgl.Image;
}

    'use strict';


    function getSource(id) {
        // TODO: Could we use HTML <script> elements instead of AJAX fetches? We could possibly
        // set the src of the script to our content, the type to something other than JS. Then, we
        // listen for the onload event. In this way, we may be able to load content from disk
        // without running a server.

        if (typeof window == 'undefined') {
            var fs = require('fs');
            return Q.denodeify(fs.readFile)('shaders/' + id, {encoding: 'utf8'});
        } else {
            var url = "shaders/" + id;
            return Q($.ajax(url, {dataType: "text"}));
        }
    }

    /**
     * Fetch an image as an HTML Image object
     *
     * @returns a promise fulfilled with the HTML Image object, once loaded
     */
    function getImage(url) {
        var deferred = Q.defer();
        var img = new Image();

        img.onload = function() {
            console.debug('IMG LOADED')
            deferred.resolve(img);
        };

        console.debug("SETTING SOURCE", url)
        img.src = url;
        console.debug("SET SOURCE")

        return deferred.promise;
    }


    // Extends target by adding the attributes of one or more other objects to it
    function extend(target, object1, objectN) {
        for (var arg = 1; arg < arguments.length; arg++) {
            for (var i in arguments[arg]) {
                target[i] = arguments[arg][i];
            }
        }
        return target;
    }


    module.exports = {
        "getSource": getSource,
        "getImage": getImage,
        "extend": extend
    };
