'use strict';

const PORT = process.env.PORT || 3000;
const INACTIVITY_TIMEOUT = process.env.INACTIVITY_TIMEOUT || 5000;

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const express = require("express");
const { Server } = require("ws");
const ShortUniqueId = require("short-unique-id");
const uid = new ShortUniqueId({ length: 10 });
const client = require('twilio')(accountSid, authToken);

const server = express()
    .listen(PORT, () => console.log(`listening on ${PORT}`));

const wss = new Server({ server });

const callings = new Map();

wss.on("connection", (ws, req) => {
    const endpoint = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    const originalSend = ws.send.bind(ws);
    ws.send = msg => {
        console.log(
            endpoint,
            "<=",
            msg,
        );
        return originalSend(msg);
    };
    const cleanups = [
        () => console.log(endpoint, "cleanup everything"),
        () => ws.terminate()
    ];
    const cleanup = () => cleanups.forEach(f => f());
    console.log(
        endpoint,
        "client connected",
        "setup inactive timeout",
        INACTIVITY_TIMEOUT
    );
    const inactiveTimeout = setTimeout(() => {
        console.log(
            endpoint,
            "client was inactive for",
            INACTIVITY_TIMEOUT,
            "disconnect"
        );
        ws.terminate();
    }, INACTIVITY_TIMEOUT);
    cleanups.push(() => clearTimeout(inactiveTimeout));

    ws.on("close", () => {
        cleanup();
        console.log(
            endpoint,
            "client disconnected"
        );
    });

    let callId = undefined;
    let role = undefined;

    const handleMessage = msg => {
        console.log(
            endpoint,
            "=>",
            msg,
        );
        if (typeof role === "undefined") {
            switch (msg.role) {
                case "caller":
                case "callee":
                    role = msg.role;
                    break;
                default:
                    throw new Exception("unknown role");
            }
        }
        switch (role) {
            case "caller": {
                if (typeof callId === "undefined") {
                    callId = uid();
                    const calling = { caller: ws, fromCaller: [msg] }
                    callings.set(callId, calling);
                    cleanups.push(() => callings.delete(callId));
                    cleanups.push(() => {
                        if (calling.callee) {
                            calling.callee.terminate();
                        }
                    });
                    clearTimeout(inactiveTimeout);
										client.tokens.create().then(token => {
										    console.log(endpoint, "allocated token", token);
                        ws.send(JSON.stringify({ callId, iceServers: token.iceServers }));
                    }).catch(err => {
                        console.log(endpoint, "failed to allocate token");
                        ws.send(JSON.stringify({ callId, iceServers: [
                            {
                                urls: "stun:stun.l.google.com:19302",
                            }
                        ]}));
                    });
                } else {
                    const calling = callings.get(callId);
                    if (!calling) {
                        throw new Error("unknown call id");
                    }

                    if (calling.callee && calling.calleeReady) {
                        calling.callee.send(JSON.stringify(msg));
                    } else {
                        calling.fromCaller.push(msg);
                    }
                }
                break;
            }
            case "callee": {
                if (typeof callId === "undefined") {
                    callId = msg.callId;
                }
                const calling = callings.get(callId);
                if (!calling) {
                    throw new Error("unknown call id");
                }
                cleanups.push(() => {
                    if (calling.caller) {
                        calling.caller.terminate();
                    }
                });
                if (calling.callee && calling.callee !== ws) {
                    throw new Error("call is already busy");
                } else {
                    calling.callee = ws;
                }

                clearTimeout(inactiveTimeout);
                client.tokens.create().then(token => {
                    console.log(endpoint, "allocated token", token);
                    ws.send(JSON.stringify({ iceServers: token.iceServers }));
                }).catch(err => {
                    console.log(endpoint, "failed to allocate token");
                    ws.send(JSON.stringify({ iceServers: [
                        {
                            urls: "stun:stun.l.google.com:19302",
                        }
                    ]}));
                }).then(() => {
                    calling.calleeReady = true;
                    calling.caller.send(JSON.stringify(msg));
                    for (const msg of calling.fromCaller) {
                        ws.send(JSON.stringify(msg));
                    }
                    calling.fromCaller = [];
                });
                break;
            }
            default:
                throw new Error("unsupported type");

        }

    };

    ws.on("message", (data, isBinary) => {
        if (isBinary) {
            console.log(
                endpoint,
                "got binary message, not supporting"
            );
            cleanup();
        }

        try {
            const msg = JSON.parse(data.toString("utf-8"));
            handleMessage(msg);
        } catch (err) {
            console.log(
                endpoint,
                "failed to handle message",
                err
            );
            cleanup();
        }
    });
});
