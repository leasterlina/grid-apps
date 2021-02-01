/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

// this code runs in kiri's main loop
let KIRI = self.kiri = self.kiri || {},
    loc = self.location,
    host = loc.hostname,
    port = loc.port,
    proto = loc.protocol,
    time = function() { return new Date().getTime() },
    seqid = 1,
    syncd = {},
    running = {},
    slicing = {},
    worker = null
    // occ = new Worker("/kiri/ext/occ-worker.js", {type:"module"}),
    ;

/**
 * @param {Function} fn name of function in KIRI.worker
 * @param {Object} data to send to server
 * @param {Function} onreply function to call on reply messages
 * @param {Object[]} zerocopy array of objects to pass using zerocopy
 */
function send(fn, data, onreply, zerocopy) {
    let seq = seqid++;

    running[seq] = { fn:onreply };
    // console.log('send', data);

    try {
        worker.postMessage({
            seq: seq,
            task: fn,
            time: time(),
            data: data
        }, zerocopy);
    } catch (error) {
        console.trace('work send error', {data, error});
    }
}

// code is running in the browser / client context
const CLIENT =
KIRI.client =
KIRI.work = {
    send: send,

    newWorker: function() {
        if (self.createWorker) {
            return self.createWorker();
        } else {
            return new Worker(`/code/worker.js?${self.kiri.version}`);
        }
    },

    isSlicing: function() {
        let current = 0;
        for (let key in slicing) {
            current++;
        }
        return current > 0;
    },

    restart: function() {
        if (worker) {
            worker.terminate();
        }

        for (let key in slicing) {
            slicing[key]({error: "cancelled slicing"});
        }

        syncd = {};
        slicing = {};
        running = {};
        worker = KIRI.work.newWorker();

        worker.onmessage = function(e) {
            let now = time(),
                reply = e.data,
                record = running[reply.seq],
                onreply = record.fn;

            // console.log('recv', reply.data)
            if (reply.done) {
                delete running[reply.seq];
            }

            // calculate and replace recv time
            reply.time_recv = now - reply.time_recv;

            onreply(reply.data, reply);
        };
    },

    decimate: function(vertices, options, callback) {
        let alert = KIRI.api.show.alert('processing model', 1000);
        vertices = vertices.buffer.slice(0);
        send("decimate", {vertices, options}, function(output) {
            KIRI.api.hide.alert(alert);
            callback(output);
        });
    },

    config: function(obj) {
        send("config", obj, function(reply) { });
    },

    clear: function(widget) {
        syncd = {};
        send("clear", widget ? {id:widget.id} : {}, function(reply) { });
    },

    snap: function(data) {
        send("snap", data, function(reply) { });
    },

    // widget sync
    sync: function() {
        let widgets = KIRI.api.widgets.all();
        widgets.forEach(widget => {
            if (widget.modified || !syncd[widget.id]) {
                syncd[widget.id] = true;
                let vertices = widget.getGeoVertices().buffer.slice(0);
                send("sync", {
                    id: widget.id,
                    group: widget.group.id,
                    track: widget.track,
                    vertices: vertices,
                    position: widget.mesh.position,
                }, done => {
                    widget.modified = false;
                }, [vertices]);
            }
        });
    },

    rotate: function(settings, callback) {
        send("rotate", { settings }, reply => {
            if (reply.group) {
                for (let widget of KIRI.Widget.Groups.forid(reply.group)) {
                    widget.belt = reply.belt;
                }
            } else if (callback) {
                callback();
            }
        });
    },

    unrotate: function(settings, callback) {
        send("unrotate", { settings }, reply => {
            if (reply.group) {
                for (let widget of KIRI.Widget.Groups.forid(reply.group)) {
                    widget.rotinfo = reply.rotinfo;
                }
            } else if (callback) {
                callback();
            }
        });
    },

    slice: function(settings, widget, callback) {
        slicing[widget.id] = callback;
        send("slice", {
            id: widget.id,
            settings: settings
        }, function(reply) {
            callback(reply);
            if (reply.done || reply.error) {
                delete slicing[widget.id];
                // in belt mode, slicing modifies a widget and requires re-sync
                if (settings.device.bedBelt) {
                    widget.modified = true;
                }
            }
        });
    },

    prepare: function(settings, update, done) {
        send("prepare", { settings }, function(reply) {
            if (reply.progress) {
                update(reply.progress, reply.message, reply.layer);
            }
            if (reply.done) {
                done(reply.output, reply.maxSpeed);
            }
        });
    },

    export: function(settings, online, ondone) {
        send("export", { settings }, function(reply) {
            if (reply.line) {
                online(reply.line);
            }
            if (reply.done) {
                ondone(reply.output);
            }
        });
    },

    colors: function(colors, max, done) {
        send("colors", { colors, max }, function(reply) {
            done(reply);
        });
    },

    parse: function(args, progress, done) {
        // have to do this client side because DOMParser is not in workers
        if (args.type === 'svg') {
            const { settings, code, type } = args;
            const origin = settings.origin;
            const offset = {
                x: origin.x,
                y: -origin.y,
                z: origin.z
            };
            const output = KIRI.newPrint().parseSVG(code, offset);
            send("parse_svg", output, function(reply) {
                if (reply.parsed) {
                    done(KIRI.codec.decode(reply.parsed));
                }
            });
            return;
        }
        send("parse", args, function(reply) {
            if (reply.progress) {
                progress(reply);
            }
            if (reply.parsed) {
                done(KIRI.codec.decode(reply.parsed), reply.maxSpeed);
            }
        });
    },

    image2mesh: function(data, progress, output) {
        send("image2mesh", data, reply => {
            if (reply.progress) {
                progress(reply.progress);
            }
            if (reply.done) {
                output(reply.done);
            }
        }, [ data.png ]);
    },

    zip: function(files, progress, output) {
        send("zip", {files}, reply => {
            if (reply.percent) {
                progress(reply);
            } else {
                output(reply);
            }
        });
    }
};

// start worker
KIRI.work.restart();

})();
