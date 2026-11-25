const http = require("http");
const https = require("https");


const defaultPort = 52735;
const maxRetries = 20;

let retryCount = 0;

function forwardRequest(clientReq, clientRes, url, method, headers) {
    let targetUrl;
    try {
        targetUrl = new URL(url);
    } catch (e) {
        clientRes.writeHead(400, { "Content-Type": "text/plain" });
        clientRes.end("Bad Request: Invalid URL");
        return;
    }

    // 确保 host 正确
    let host = headers?.host;

    if (!host || host.includes("localhost") || host.includes("127.0.0.1")) {
        host = targetUrl.host;
    }

    const options = {
        method: method,
        headers: {
            ...(headers || {}),
            host,
        },
    };

    const protocol = targetUrl.protocol === "https:" ? https : http;
    let upstreamRes = null;

    const req = protocol.request(targetUrl, options, (targetRes) => {
        upstreamRes = targetRes;

        targetRes.on("error", (err) => {
            if (!clientRes.destroyed) {
                clientRes.destroy(err);
            }
        });

        if (!clientRes.headersSent) {
            clientRes.writeHead(targetRes.statusCode, targetRes.headers);
        }

        targetRes.pipe(clientRes, {
            end: true,
        });
    });

    // 客户端切歌/拖动取消请求时，立刻终止上游连接，避免浪费服务器带宽
    const abortUpstream = () => {
        if (!req.destroyed) {
            req.destroy();
        }
        if (upstreamRes && !upstreamRes.destroyed) {
            upstreamRes.destroy();
        }
    };

    clientReq.on("aborted", abortUpstream);
    clientRes.on("close", () => {
        if (!clientRes.writableEnded) {
            abortUpstream();
        }
    });

    req.on("error", (error) => {
        // 客户端主动取消触发的 ECONNRESET/ABORT 无需报错
        if (clientRes.destroyed || clientReq.aborted) {
            return;
        }
        console.error("Error forwarding request:", error);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { "Content-Type": "text/plain" });
            clientRes.end("Bad Gateway");
        } else if (!clientRes.writableEnded) {
            clientRes.destroy();
        }
    });

    req.end();
}


function safeParse(data) {
    try {
        return JSON.parse(data) || {};
    } catch (e) {
        return {};
    }
}


function startServer(port) {
    const server = http.createServer((req, res) => {
        if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            return res.end("Only GET requests are allowed");
        }

        if (req.url === "/heartbeat") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            return res.end("OK");
        }

        const queryIndex = req.url.indexOf("?");
        const query = new URLSearchParams(queryIndex >= 0 ? req.url.slice(queryIndex + 1) : "");

        const url = query.get("url");
        const method = query.get("method") || "GET";
        const headers = safeParse(query.get("headers"));

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

        if (!url) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            return res.end("Bad Request: Missing URL");
        }

        forwardRequest(req, res, url, method, {
            ...(req.headers || {}),
            ...(headers || {}),
        });
    });

    // 仅监听本机回环地址，防止局域网暴露为开放代理
    server.listen(port, "127.0.0.1", () => {
        process.send?.({
            type: "port",
            port,
        });
        console.log(`Proxy server is running on http://127.0.0.1:${port}`);
    });

    server.on("error", (err) => {
        console.error("Server error:", err);
        if (retryCount < maxRetries) {
            retryCount++;
            const newPort = port + 1;
            console.log(`Retrying on port: ${newPort} (attempt ${retryCount})`);
            startServer(newPort);
        } else {
            process.send?.({ type: "error", error: "Max retries reached" });
        }
    });
}


startServer(defaultPort);
