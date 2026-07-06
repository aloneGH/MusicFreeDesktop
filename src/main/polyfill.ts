// Polyfill global.File for Electron main process (Node.js < 20 environment)
if (typeof global.File === "undefined") {
    // @ts-ignore
    global.File = class File {};
}
