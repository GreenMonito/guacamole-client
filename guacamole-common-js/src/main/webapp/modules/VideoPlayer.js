/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

var Guacamole = Guacamole || {};

/**
 * Abstract video player which accepts, queues and plays back arbitrary video
 * data. It is up to implementations of this class to provide some means of
 * handling a provided Guacamole.InputStream and rendering the received data to
 * the provided Guacamole.Display.VisibleLayer. Data received along the
 * provided stream is to be played back immediately.
 *
 * @constructor
 */
Guacamole.VideoPlayer = function VideoPlayer() {

    /**
     * Notifies this Guacamole.VideoPlayer that all video up to the current
     * point in time has been given via the underlying stream, and that any
     * difference in time between queued video data and the current time can be
     * considered latency.
     */
    this.sync = function sync() {
        // Default implementation - do nothing
    };

};

/**
 * Determines whether the given mimetype is supported by any built-in
 * implementation of Guacamole.VideoPlayer, and thus will be properly handled
 * by Guacamole.VideoPlayer.getInstance().
 *
 * @param {!string} mimetype
 *     The mimetype to check.
 *
 * @returns {!boolean}
 *     true if the given mimetype is supported by any built-in
 *     Guacamole.VideoPlayer, false otherwise.
 */
Guacamole.VideoPlayer.isSupportedType = function isSupportedType(mimetype) {
    return Guacamole.H264VideoPlayer.isSupportedType(mimetype);
};

/**
 * Returns a list of all mimetypes supported by any built-in
 * Guacamole.VideoPlayer, in rough order of priority. Beware that only the core
 * mimetypes themselves will be listed. Any mimetype parameters, even required
 * ones, will not be included in the list.
 *
 * @returns {!string[]}
 *     A list of all mimetypes supported by any built-in Guacamole.VideoPlayer,
 *     excluding any parameters.
 */
Guacamole.VideoPlayer.getSupportedTypes = function getSupportedTypes() {
    return Guacamole.H264VideoPlayer.getSupportedTypes();
};

/**
 * Returns an instance of Guacamole.VideoPlayer providing support for the given
 * video format. If support for the given video format is not available, null
 * is returned.
 *
 * @param {!Guacamole.InputStream} stream
 *     The Guacamole.InputStream to read video data from.
 *
 * @param {!Guacamole.Display.VisibleLayer} layer
 *     The destination layer in which this Guacamole.VideoPlayer should play
 *     the received video data.
 *
 * @param {!string} mimetype
 *     The mimetype of the video data in the provided stream.
 *
 * @return {Guacamole.VideoPlayer}
 *     A Guacamole.VideoPlayer instance supporting the given mimetype and
 *     reading from the given stream, or null if support for the given mimetype
 *     is absent.
 */
Guacamole.VideoPlayer.getInstance = function getInstance(stream, layer, mimetype) {

    if (Guacamole.H264VideoPlayer.isSupportedType(mimetype))
        return new Guacamole.H264VideoPlayer(stream, layer);

    return null;

};

/**
 * Implementation of Guacamole.VideoPlayer which decodes H.264 with the
 * browser's WebCodecs API and draws each decoded frame directly onto the
 * canvas of the given layer. The stream carries H.264 access units in Annex B
 * format, each prefixed by a 9-byte header: the length of the access unit
 * (uint32, big endian), flags (bit 0 set for keyframes) and a timestamp in
 * milliseconds (uint32, big endian). This is the format guacd uses when a
 * connection streams its display as video ("video-codec" parameter).
 *
 * @constructor
 * @augments Guacamole.VideoPlayer
 * @param {!Guacamole.InputStream} stream
 *     The Guacamole.InputStream to read video data from.
 *
 * @param {!Guacamole.Display.VisibleLayer} layer
 *     The destination layer in which this Guacamole.H264VideoPlayer should
 *     display the received video.
 */
Guacamole.H264VideoPlayer = function H264VideoPlayer(stream, layer) {

    Guacamole.VideoPlayer.call(this);

    /**
     * The size of the header preceding each access unit, in bytes.
     *
     * @private
     * @constant
     * @type {!number}
     */
    var HEADER_SIZE = 9;

    /**
     * Received bytes that do not yet form a complete access unit.
     *
     * @private
     * @type {!Uint8Array}
     */
    var buffer = new Uint8Array(65536);

    /**
     * The number of bytes of buffer currently in use.
     *
     * @private
     * @type {!number}
     */
    var length = 0;

    /**
     * The WebCodecs decoder, created on the first keyframe (its codec string
     * comes from that keyframe's SPS), or null.
     *
     * @private
     * @type {VideoDecoder}
     */
    var decoder = null;

    /**
     * Whether the stream has ended and nothing further should be decoded or
     * drawn.
     *
     * @private
     * @type {!boolean}
     */
    var ended = false;

    /**
     * The 2D context of the destination layer's canvas.
     *
     * @private
     * @type {!CanvasRenderingContext2D}
     */
    var context = layer.getCanvas().getContext('2d');

    /**
     * Returns the RFC 6381 codec string ("avc1.PPCCLL") for the first SPS
     * within the given Annex B access unit, or null if there is none.
     *
     * @private
     * @param {!Uint8Array} data
     *     The access unit to search.
     *
     * @returns {string}
     *     The codec string, or null.
     */
    var getCodecString = function getCodecString(data) {

        var hex = function hex(value) {
            return ('0' + value.toString(16)).slice(-2);
        };

        for (var i = 0; i + 7 < data.length; i++) {
            if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1
                    && (data[i + 3] & 0x1F) === 7)
                return 'avc1.' + hex(data[i + 4]) + hex(data[i + 5]) + hex(data[i + 6]);
        }

        return null;

    };

    /**
     * Closes the decoder, if any. A new one is created on the next keyframe.
     *
     * @private
     */
    var closeDecoder = function closeDecoder() {

        if (decoder && decoder.state !== 'closed') {
            try {
                decoder.close();
            }
            catch (e) {
                // Already closed
            }
        }

        decoder = null;

    };

    /**
     * Creates and configures a decoder for the given keyframe.
     *
     * @private
     * @param {!Uint8Array} data
     *     The keyframe access unit.
     *
     * @returns {!boolean}
     *     true if the decoder is ready, false otherwise.
     */
    var openDecoder = function openDecoder(data) {

        var codec = getCodecString(data);
        if (!codec)
            return false;

        decoder = new VideoDecoder({

            output: function frameDecoded(frame) {
                if (!ended)
                    context.drawImage(frame, 0, 0);
                frame.close();
            },

            error: function decodeFailed(e) {
                console.warn('H.264 video decoding failed: ' + e.message
                        + '. Waiting for the next keyframe.');
                decoder = null;
            }

        });

        decoder.configure({
            codec: codec,
            optimizeForLatency: true
        });

        return true;

    };

    /**
     * Decodes a single access unit.
     *
     * @private
     * @param {!Uint8Array} data
     *     The access unit, in Annex B format.
     *
     * @param {!boolean} key
     *     Whether the access unit is a keyframe.
     *
     * @param {!number} timestamp
     *     The timestamp of the access unit, in milliseconds.
     */
    var decode = function decode(data, key, timestamp) {

        // A decoder can only start (or recover) at a keyframe, and a new
        // keyframe may carry a different SPS (resolution, level)
        if (key) {
            closeDecoder();
            if (!openDecoder(data))
                return;
        }
        else if (!decoder || decoder.state !== 'configured')
            return;

        try {
            decoder.decode(new EncodedVideoChunk({
                type: key ? 'key' : 'delta',
                timestamp: timestamp * 1000,
                data: data
            }));
        }
        catch (e) {
            console.warn('H.264 video decoding failed: ' + e.message
                    + '. Waiting for the next keyframe.');
            closeDecoder();
        }

    };

    /**
     * Appends received bytes and decodes every complete access unit.
     *
     * @private
     * @param {!ArrayBuffer} data
     *     The received bytes.
     */
    var receive = function receive(data) {

        var bytes = new Uint8Array(data);

        // Grow the buffer as needed
        if (length + bytes.length > buffer.length) {
            var grown = new Uint8Array(Math.max(buffer.length * 2, length + bytes.length));
            grown.set(buffer.subarray(0, length));
            buffer = grown;
        }

        buffer.set(bytes, length);
        length += bytes.length;

        var offset = 0;
        while (length - offset >= HEADER_SIZE) {

            var size = ((buffer[offset] << 24) >>> 0) + (buffer[offset + 1] << 16)
                     + (buffer[offset + 2] << 8) + buffer[offset + 3];

            if (length - offset < HEADER_SIZE + size)
                break;

            var key = (buffer[offset + 4] & 0x01) !== 0;
            var timestamp = ((buffer[offset + 5] << 24) >>> 0) + (buffer[offset + 6] << 16)
                          + (buffer[offset + 7] << 8) + buffer[offset + 8];

            var start = offset + HEADER_SIZE;
            decode(buffer.slice(start, start + size), key, timestamp);

            offset = start + size;

        }

        // Keep only the incomplete remainder
        if (offset > 0) {
            buffer.copyWithin(0, offset, length);
            length -= offset;
        }

    };

    var reader = new Guacamole.ArrayBufferReader(stream);
    reader.ondata = receive;
    reader.onend = function streamEnded() {
        ended = true;
        closeDecoder();
    };

};

Guacamole.H264VideoPlayer.prototype = new Guacamole.VideoPlayer();

/**
 * Returns whether this browser can decode H.264 through WebCodecs, which is
 * only available in secure contexts (HTTPS or localhost).
 *
 * @returns {!boolean}
 *     true if Guacamole.H264VideoPlayer can be used, false otherwise.
 */
Guacamole.H264VideoPlayer.isAvailable = function isAvailable() {
    return typeof window !== 'undefined'
        && typeof window.VideoDecoder === 'function'
        && typeof window.EncodedVideoChunk === 'function'
        && window.isSecureContext !== false;
};

/**
 * Determines whether the given mimetype is supported by
 * Guacamole.H264VideoPlayer.
 *
 * @param {!string} mimetype
 *     The mimetype to check.
 *
 * @returns {!boolean}
 *     true if the given mimetype is supported, false otherwise.
 */
Guacamole.H264VideoPlayer.isSupportedType = function isSupportedType(mimetype) {
    return mimetype === 'video/h264' && Guacamole.H264VideoPlayer.isAvailable();
};

/**
 * Returns the mimetypes supported by Guacamole.H264VideoPlayer.
 *
 * @returns {!string[]}
 *     ['video/h264'] if this browser can decode it, an empty array otherwise.
 */
Guacamole.H264VideoPlayer.getSupportedTypes = function getSupportedTypes() {
    return Guacamole.H264VideoPlayer.isAvailable() ? [ 'video/h264' ] : [];
};
