
var Q = require('Q');
var util = require('./util.js');
var cljs = require('./cl.js');

if (typeof(window) == 'undefined') {
    webcl = require('node-webcl');
}



    "use strict";

    Q.longStackSupport = true;
    var randLength = 73;


    function create(renderer, dimensions, numSplits, locked) {
        return cljs.create(renderer.gl)
        .then(function(cl) {
            console.error('GOT CL')
            // Compile the WebCL kernels
            return util.getSource("apply-forces.cl")
            .then(function(source) {
                console.error('GOT SOURCE')
                return cl.compile(source, ["apply_points", "apply_springs", "apply_midpoints", "apply_midsprings"]);
            })
            .then(function(kernels) {
                console.error('COMPILED')
                var simObj = {
                    "renderer": renderer,
                    "cl": cl,
                    "pointKernel": kernels["apply_points"],
                    "edgesKernel": kernels["apply_springs"],
                    "midPointKernel": kernels["apply_midpoints"],
                    "midEdgesKernel": kernels["apply_midsprings"],
                    "elementsPerPoint": 2
                };
                simObj.tick = tick.bind(this, simObj);
                simObj.setPoints = setPoints.bind(this, simObj);
                simObj.setEdges = setEdges.bind(this, simObj);
                simObj.setLocked = setLocked.bind(this, simObj);
                simObj.setPhysics = setPhysics.bind(this, simObj);
                simObj.resetBuffers = resetBuffers.bind(this, simObj);

                simObj.dimensions = dimensions;
                simObj.numSplits = numSplits;
                simObj.numPoints = 0;
                simObj.numEdges = 0;
                simObj.locked = util.extend(
                    {lockPoints: false, lockMidpoints: true, lockEdges: false, lockMidedges: true},
                    (locked || {})
                );

                simObj.buffers = {
                    nextPoints: null,
                    randValues: null,
                    curPoints: null,
                    forwardsEdges: null,
                    forwardsWorkItems: null,
                    backwardsEdges: null,
                    backwardsWorkItems: null,
                    springsPos: null,
                    midSpringsPos: null,
                    midSpringsColorCoord: null
                };

                console.debug("WebCL simulator created");
                return simObj
            }, function (err) {
                console.error('Could not compile sim', err)
            });
        }, function (err) {
            console.error('Could not create sim', err);
            return err;
        })

    }


    /**
     * Given an array of (potentially null) buffers, delete the non-null buffers and set their
     * variable in the simulator buffer object to null.
     */
    var resetBuffers = function(simulator, buffers) {
        var validBuffers = buffers.filter(function(val) { return !(!val); });
        if(validBuffers.length == 0) {
            return Q(null);
        }

        // Search for the buffer in the simulator's buffer object, and set it to null there
        validBuffers.forEach(function(buffToDelete) {
            for(var buff in simulator.buffers) {
                if(simulator.buffers.hasOwnProperty(buff) && simulator.buffers[buff] == buffToDelete) {
                    simulator.buffers[buff] = null;
                }
            }
        });

        validBuffers.map(function(buffToDelete) {
            buffToDelete.delete();
        })

        return Q.all(validBuffers);
    };


    /**
     * Set the initial positions of the points in the NBody simulation
     * @param simulator - the simulator object created by SimCL.create()
     * @param {Float32Array} points - a typed array containing two elements for every point, the x
     * position, proceeded by the y position
     *
     * @returns a promise fulfilled by with the given simulator object
     */
    function setPoints(simulator, points) {
        if(points.length < 1) {
            throw new Error("The points buffer is empty");
        }
        if(points.length % simulator.elementsPerPoint !== 0) {
            throw new Error("The points buffer is an invalid size (must be a multiple of " + simulator.elementsPerPoint + ")");
        }

        return simulator.resetBuffers([
            simulator.buffers.nextPoints,
            simulator.buffers.randValues,
            simulator.buffers.curPoints
        ])
        .then(function() {
            simulator.numPoints = points.length / simulator.elementsPerPoint;
            simulator.renderer.numPoints = simulator.numPoints;

            console.debug("Number of points:", simulator.renderer.numPoints);

            // Create buffers and write initial data to them, then set
            return Q.all([
                    simulator.renderer.createBuffer(points),
                    simulator.cl.createBuffer(points.byteLength),
                    simulator.cl.createBuffer(randLength * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT)
                ]);
        })
        .spread(function(pointsVBO, nextPointsBuffer, randBuffer) {
            simulator.buffers.nextPoints = nextPointsBuffer;

            simulator.renderer.buffers.curPoints = pointsVBO;

            // Generate an array of random values we will write to the randValues buffer
            simulator.buffers.randValues = randBuffer;
            var rands = new Float32Array(randLength * simulator.elementsPerPoint);
            for(var i = 0; i < rands.length; i++) {
                rands[i] = Math.random();
            }

            return Q.all([
                simulator.cl.createBufferGL(pointsVBO),
                simulator.buffers.randValues.write(rands)]);
        })
        .spread(function(pointsBuf, randValues) {
            simulator.buffers.curPoints = pointsBuf;

            var localPosSize = Math.min(simulator.cl.maxThreads, simulator.numPoints) * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT;
            console.error("SETTING POINT 0", "FIXME: dyn alloc __local, not hardcode in kernel");
            return simulator.pointKernel.setArgs([
                    webcl.type ? [simulator.numPoints] : new Uint32Array([simulator.numPoints]),
                    simulator.buffers.curPoints.buffer,
                    simulator.buffers.nextPoints.buffer,
                    webcl.type ? [1] : new Uint32Array([localPosSize]),
                    webcl.type ? [simulator.dimensions[0]] : new Float32Array([simulator.dimensions[0]]),
                    webcl.type ? [simulator.dimensions[1]] : new Float32Array([simulator.dimensions[1]]),
                    webcl.type ? [-0.00001] : new Float32Array([-0.00001]),
                    webcl.type ? [0.2] : new Float32Array([0.2]),
                    simulator.buffers.randValues.buffer,
                    webcl.type ? [0] : new Uint32Array([0])
                ],
                webcl.type ? [
                    webcl.type.UINT,
                    null, null,
                    webcl.type.LOCAL_MEMORY_SIZE,
                    webcl.type.FLOAT,
                    webcl.type.FLOAT,
                    webcl.type.FLOAT,
                    webcl.type.FLOAT,
                    null,
                    webcl.type.UINT
                ] : undefined);
        })
        .then(function() {
            return simulator;
        });
    }


    /**
     * Sets the edge list for the graph
     *
     * @param simulator - the simulator object to set the edges for
     * @param {edgesTyped: {Uint32Array}, numWorkItems: uint, workItemsTyped: {Uint32Array} } forwardsEdges -
     *        Edge list as represented in input graph.
     *        edgesTyped is buffer where every two items contain the index of the source
     *        node for an edge, and the index of the target node of the edge.
     *        workItems is a buffer where every two items encode information needed by
     *         one thread: the index of the first edge it should process, and the number of
     *         consecutive edges it should process in total.
     * @param {edgesTyped: {Uint32Array}, numWorkItems: uint, workItemsTypes: {Uint32Array} } backwardsEdges -
     *        Same as forwardsEdges, except reverse edge src/dst and redefine workItems/numWorkItems corresondingly.
     * @param {Float32Array} midPoints - dense array of control points (packed sequence of nDim structs)
     * @returns {Q.promise} a promise for the simulator object
     */
    function setEdges(simulator, forwardsEdges, backwardsEdges, midPoints) {
        //edges, workItems
        var elementsPerEdge = 2; // The number of elements in the edges buffer per spring
        var elementsPerWorkItem = 2;

        if(forwardsEdges.edgesTyped.length < 1) {
            throw new Error("The edge buffer is empty");
        }
        if(forwardsEdges.edgesTyped.length % elementsPerEdge !== 0) {
            throw new Error("The edge buffer size is invalid (must be a multiple of " + elementsPerEdge + ")");
        }
        if(forwardsEdges.workItemsTyped.length < 1) {
            throw new Error("The work items buffer is empty");
        }
        if(forwardsEdges.workItemsTyped.length % elementsPerWorkItem !== 0) {
            throw new Error("The work item buffer size is invalid (must be a multiple of " + elementsPerWorkItem + ")");
        }

        return simulator.resetBuffers([
            simulator.buffers.forwardsEdges,
            simulator.buffers.forwardsWorkItems,
            simulator.buffers.backwardsEdges,
            simulator.buffers.backwardsWorkItems,
            simulator.buffers.springsPos,
            simulator.buffers.midSpringsPos,
            simulator.buffers.midSpringsColorCoord
        ])
        .then(function() {
            // Init constant
            simulator.numEdges = forwardsEdges.edgesTyped.length / elementsPerEdge;
            simulator.renderer.numEdges = simulator.numEdges;
            simulator.numForwardsWorkItems = forwardsEdges.workItemsTyped.length / elementsPerWorkItem;
            simulator.numBackwardsWorkItems = backwardsEdges.workItemsTyped.length / elementsPerWorkItem;

            simulator.numMidPoints = midPoints.length / simulator.elementsPerPoint;
            simulator.renderer.numMidPoints = simulator.numMidPoints;
            simulator.numMidEdges = simulator.numMidPoints + simulator.numEdges;
            simulator.renderer.numMidEdges = simulator.numMidEdges;

            // Create buffers
            return Q.all([
                simulator.cl.createBuffer(forwardsEdges.edgesTyped.byteLength),
                simulator.cl.createBuffer(forwardsEdges.workItemsTyped.byteLength),
                simulator.cl.createBuffer(backwardsEdges.edgesTyped.byteLength),
                simulator.cl.createBuffer(backwardsEdges.workItemsTyped.byteLength),
                simulator.cl.createBuffer(midPoints.byteLength),
                simulator.renderer.createBuffer(simulator.numEdges * elementsPerEdge * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT),
                simulator.renderer.createBuffer(midPoints),
                simulator.renderer.createBuffer(simulator.numMidEdges * elementsPerEdge * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT),
                simulator.renderer.createBuffer(simulator.numMidEdges * elementsPerEdge * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT)]);
        })
        .spread(function(forwardsEdgesBuffer, forwardsWorkItemsBuffer, backwardsEdgesBuffer,
                         backwardsWorkItemsBuffer, nextMidPointsBuffer, springsVBO,
                         midPointsVBO, midSpringsVBO, midSpringsColorCoordVBO) {
            // Bind buffers
            simulator.buffers.forwardsEdges = forwardsEdgesBuffer;
            simulator.buffers.forwardsWorkItems = forwardsWorkItemsBuffer;
            simulator.buffers.backwardsEdges = backwardsEdgesBuffer;
            simulator.buffers.backwardsWorkItems = backwardsWorkItemsBuffer;
            simulator.buffers.nextMidPoints = nextMidPointsBuffer;

            simulator.renderer.buffers.springs = springsVBO;
            simulator.renderer.buffers.curMidPoints = midPointsVBO;
            simulator.renderer.buffers.midSprings = midSpringsVBO;
            simulator.renderer.buffers.midSpringsColorCoord = midSpringsColorCoordVBO;

            return Q.all([
                simulator.cl.createBufferGL(springsVBO),
                simulator.cl.createBufferGL(midPointsVBO),
                simulator.cl.createBufferGL(midSpringsVBO),
                simulator.cl.createBufferGL(midSpringsColorCoordVBO),
                simulator.buffers.forwardsEdges.write(forwardsEdges.edgesTyped),
                simulator.buffers.forwardsWorkItems.write(forwardsEdges.workItemsTyped),
                simulator.buffers.backwardsEdges.write(backwardsEdges.edgesTyped),
                simulator.buffers.backwardsWorkItems.write(backwardsEdges.workItemsTyped),
            ]);
        })
        .spread(function(springsBuffer, midPointsBuf, midSpringsBuffer, midSpringsColorCoordBuffer) {
            simulator.buffers.springsPos = springsBuffer;
            simulator.buffers.midSpringsPos = midSpringsBuffer;
            simulator.buffers.curMidPoints = midPointsBuf;
            simulator.buffers.midSpringsColorCoord = midSpringsColorCoordBuffer;

            var localPosSize = Math.min(simulator.cl.maxThreads, simulator.numMidPoints) * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT;
            console.error('aaa')
            var midPointArgs = simulator.midPointKernel.setArgs([
                    webcl.type ? [simulator.numMidPoints] : new Uint32Array([simulator.numMidPoints]),
                    webcl.type ? [simulator.numSplits] : new Uint32Array([simulator.numSplits]),
                    simulator.buffers.curMidPoints.buffer,
                    simulator.buffers.nextMidPoints.buffer,

                    webcl.type ? [localPosSize] : new Uint32Array([localPosSize]),

                    webcl.type ? [simulator.dimensions[0]] : new Float32Array([simulator.dimensions[0]]),
                    webcl.type ? [simulator.dimensions[1]] : new Float32Array([simulator.dimensions[1]]),
                    webcl.type ? [-0.00001] : new Float32Array([-0.00001]),
                    webcl.type ? [0.2] : new Float32Array([0.2]),

                    simulator.buffers.randValues.buffer,
                    webcl.type ? [0] : new Uint32Array([0])],
                webcl.type ? [
                    webcl.type.UINT, webcl.type.UINT, null, null,
                    webcl.type.LOCAL_MEMORY_SIZE, webcl.type.FLOAT, webcl.type.FLOAT, webcl.type.FLOAT,webcl.type.FLOAT,
                null, webcl.type.UINT] : null);
            console.error('bbb')

            console.error('EDGES KERNEL 0')
            var edgeArgs = simulator.edgesKernel.setArgs(
                [   null, //forwards/backwards picked dynamically
                    null, //forwards/backwards picked dynamically
                    null, //simulator.buffers.curPoints.buffer then simulator.buffers.nextPoints.buffer
                    null, //simulator.buffers.nextPoints.buffer then simulator.buffers.curPoints.buffer
                    simulator.buffers.springsPos.buffer,
                    webcl.type ? [1.0] : new Float32Array([1.0]),
                    webcl.type ? [0.1] : new Float32Array([0.1]),
                    null],
                webcl.type ? [null, null, null, null, null,
                    webcl.type.FLOAT, webcl.type.FLOAT]
                    : null);
            console.error('ARGS', [
                    null, //forwards/backwards picked dynamically
                    null, //forwards/backwards picked dynamically
                    null, //simulator.buffers.curPoints.buffer then simulator.buffers.nextPoints.buffer
                    null, //simulator.buffers.nextPoints.buffer then simulator.buffers.curPoints.buffer
                    simulator.buffers.springsPos.buffer,
                    webcl.type ? [1.0] : new Float32Array([1.0]),
                    webcl.type ? [0.1] : new Float32Array([0.1]),
                    null])
            console.error('TYPES',  webcl.type ? [null, null, null, null, null,
                    webcl.type.FLOAT, webcl.type.FLOAT]
                    : null)


                        console.error('ccc')


            var midEdgeArgs = simulator.midEdgesKernel.setArgs([
                webcl.type ? [simulator.numSplits] : new Uint32Array([simulator.numSplits]),        // 0:
                simulator.buffers.forwardsEdges.buffer,        // 1: only need one direction as guaranteed to be chains
                simulator.buffers.forwardsWorkItems.buffer,    // 2:
                simulator.buffers.curPoints.buffer,            // 3:
                simulator.buffers.nextMidPoints.buffer,        // 4:
                simulator.buffers.curMidPoints.buffer,         // 5:
                simulator.buffers.midSpringsPos.buffer,        // 6:
                simulator.buffers.midSpringsColorCoord.buffer, // 7:
                webcl.type ? [1.0] : new Float32Array([1.0]),  // 8:
                webcl.type ? [0.1] : new Float32Array([0.1]),  // 9:
                null
            ],
                webcl.type ? [
                    webcl.type.UINT, null, null, null, null, null, null, null,
                    webcl.type.FLOAT, webcl.type.FLOAT, /*webcl.type.UINT*/null
                ] : null);

            console.error('ddd')

            return Q.all(midPointArgs, edgeArgs, midEdgeArgs);
        })
        .then(function() {
                        console.error('eee')

            return simulator;
        });
    }


    function setLocked(simulator, cfg) {
        cfg = cfg || {};
        util.extend(simulator.locked, cfg);
    }


    function setPhysics(simulator, cfg) {
        // TODO: Instead of setting these kernel args immediately, we should make the physics values
        // properties of the simulator object, and just change those properties. Then, when we run
        // the kernels, we set the arg using the object property (the same way we set stepNumber.)

        cfg = cfg || {};

        if(cfg.charge || cfg.gravity) {
            var charge = cfg.charge ? (webcl.type ? [cfg.charge] : new Float32Array([cfg.charge])) : null;
            var charge_t = cfg.charge ? cljs.types.float_t : null;

            var gravity = cfg.gravity ? (webcl.type ? [cfg.gravity] : new Float32Array([cfg.gravity])) : null;
            var gravity_t = cfg.gravity ? cljs.types.float_t : null;

            console.error("SETTING POINT 1")
            simulator.pointKernel.setArgs(
                [null, null, null, null, null, null, charge, gravity, null, null],
                [null, null, null, null, null, null, charge_t, gravity_t, null, null]);

            simulator.midPointKernel.setArgs(
                [null, null, null, null, null, null, null, charge, gravity, null, null],
                [null, null, null, null, null, null, null, charge_t, gravity_t, null, null]);

        }

        if(cfg.edgeDistance || cfg.edgeStrength) {
            var edgeDistance = cfg.edgeDistance ? (webcl.type ? [cfg.edgeDistance] : new Float32Array([cfg.edgeDistance])) : null;
            var edgeDistance_t = cfg.edgeDistance ? cljs.types.float_t : null;

            var edgeStrength = cfg.edgeStrength ? (webcl.type ? [cfg.edgeStrength] : new Float32Array([cfg.edgeStrength])) : null;
            var edgeStrength_t = cfg.edgeStrength ? cljs.types.float_t : null;

            console.error("EDGES KERNEL 1")
            simulator.edgesKernel.setArgs(
                [null, null, null, null, null, edgeStrength, edgeDistance, null],
                [null, null, null, null, null, edgeStrength_t, edgeDistance_t, null]);

            simulator.midEdgesKernel.setArgs(
                // 0   1     2     3     4     5     6     7     8               9               10
                [null, null, null, null, null, null, null, null, edgeStrength,   edgeDistance,   null],
                [null, null, null, null, null, null, null, null, edgeStrength_t, edgeDistance_t, null]);
        }
    }


    function tick(simulator, stepNumber) {

        function edgeKernelSeq (edges, workItems, numWorkItems, fromPoints, toPoints) {
            simulator.edgesKernel.setArgs(
                [edges.buffer, workItems.buffer, fromPoints.buffer, toPoints.buffer, null,
                 null, null, webcl.type ? [stepNumber] : new Uint32Array([stepNumber])],
                [null, null, null, null, null,
                 null, null, cljs.types.uint_t]);
            console.error('edge call', cljs.types.uint_t, numWorkItems)
            return simulator.edgesKernel.call(numWorkItems, [])
        }

        // If there are no points in the graph, don't run the simulation
        if(simulator.numPoints < 1) {
            return Q(simulator);
        }

        ////////////////////////////
        // Run the points kernel
        return Q()
        .then(function () {
            console.error('SETTING POINT 2')
            simulator.pointKernel.setArgs(
                [null, null, null, null, null, null, null, null, null, webcl.type ? [stepNumber] : new Uint32Array([stepNumber])],
                [null, null, null, null, null, null, null, null, null, cljs.types.uint_t]);
        })
        .then(function () {
            console.error('acquiring')
            return simulator.buffers.curPoints.acquire(); })
        .then(function() {
            console.error('(FIXME POINT NOOP)')
            console.error('run point', simulator.locked.lockPoints ? false : true)
            return simulator.locked.lockPoints ? false : simulator.pointKernel.call(simulator.numPoints, []);
        })
        .then(function () {
            return simulator.buffers.nextPoints.copyInto(simulator.buffers.curPoints); },
            function (err) {
                console.error('bad run point call', err);
                return err;
            })
        .then(function() {
            console.error('copied?')
            if(simulator.numEdges > 0) {
                if (simulator.locked.lockEdges) {
                    console.error('sim')
                    return simulator;
                } else {
                    console.error('EDGE SEQ');
                    return edgeKernelSeq(
                        simulator.buffers.forwardsEdges, simulator.buffers.forwardsWorkItems, simulator.numForwardsWorkItems,
                        simulator.buffers.curPoints, simulator.buffers.nextPoints)
                    .then(function () {
                        console.error('forward, now back')
                         return edgeKernelSeq(
                            simulator.buffers.backwardsEdges, simulator.buffers.backwardsWorkItems, simulator.numBackwardsWorkItems,
                            simulator.buffers.nextPoints, simulator.buffers.curPoints); },
                        function (err) {
                            console.error('bad edge seq call', err);
                            return err;
                        });
                }
            } else {
                return simulator;
            }
        })
        .then(function() {
            console.error('edged')
            return simulator.buffers.curPoints.release();
        })
        ////////////////////////////
        // Run the edges kernel
        .then(function () {
            console.error('SET MIDPOINT')

            simulator.midPointKernel.setArgs(
                [null, null, null, null, null, null, null, null, null, null, webcl.type ? [stepNumber] : new Uint32Array([stepNumber])],
                [null, null, null, null, null, null, null, null, null, null, cljs.types.uint_t]);
        })
        .then(function() {
            console.error('MIDPOINT READY')
            return Q.all([
                simulator.buffers.curMidPoints.acquire(),
                simulator.buffers.midSpringsColorCoord.acquire()
            ]);
        })
        .spread(function() {
            console.error('CALL MIDPOINT')
            return simulator.locked.lockMidpoints ? simulator : simulator.midPointKernel.call(simulator.numMidPoints, []);  // APPLY MID-FORCES
        })
        .then(function() {
            console.error('COPY MIDPOINT')
            return simulator.buffers.nextMidPoints.copyInto(simulator.buffers.curMidPoints);
        })
        .then(function () {
            console.error('SET+CALL MID EDGES')
            if (simulator.numEdges > 0 && !simulator.locked.lockMidedges) {
                simulator.midEdgesKernel.setArgs(
                    // 0   1     2     3     4     5     6     7     8     9     10
                    [null, null, null, null, null, null, null, null, null, null, webcl.type ? [stepNumber] : new Uint32Array([stepNumber])],
                    [null, null, null, null, null, null, null, null, null, null, cljs.types.uint_t]);
                return simulator.midEdgesKernel.call(simulator.numForwardsWorkItems, [])
                .then(function() {
                    return simulator;
                })
            } else {
                return simulator;
            }
        })
        .then(function() {
            console.error('release midpoint')
            return Q.all([
                simulator.buffers.curMidPoints.release(),
                simulator.buffers.midSpringsColorCoord.release()
            ]);
        })
        .spread(function () {
            console.error('q finish')
            simulator.cl.queue.finish(); //FIXME use callback arg
            return simulator;
        });
    }


    module.exports = {
        "create": create,
        "setLocked": setLocked,
        "setPoints": setPoints,
        "setEdges": setEdges,
        "tick": tick
    };
