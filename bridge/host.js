#!/usr/bin/env node
"use strict"

const fs = require("fs")
const path = require("path")
const os = require("os")

const USAGE_DIR = path.join(os.homedir(), ".token-tracker")
const USAGE_FILE = path.join(USAGE_DIR, "usage.json")

// Native messaging: 4-byte LE length prefix, then JSON

function readMessage() {
  return new Promise((resolve, reject) => {
    let headerBuf = Buffer.alloc(0)

    function readHeader() {
      if (headerBuf.length >= 4) {
        const len = headerBuf.readUInt32LE(0)
        if (len === 0) return resolve(null)
        readBody(len, headerBuf.slice(4))
        return
      }
      process.stdin.once("data", (chunk) => {
        headerBuf = Buffer.concat([headerBuf, chunk])
        readHeader()
      })
      process.stdin.once("end", () => resolve(null))
    }

    function readBody(len, initial) {
      const bodyChunks = initial.length > 0 ? [initial] : []
      let received = initial.length

      function tryParse() {
        if (received >= len) {
          const body = Buffer.concat(bodyChunks).slice(0, len)
          try {
            resolve(JSON.parse(body.toString("utf-8")))
          } catch (e) {
            reject(new Error("Invalid JSON: " + e.message))
          }
        }
      }

      tryParse()
      if (received < len) {
        process.stdin.on("data", (chunk) => {
          bodyChunks.push(chunk)
          received += chunk.length
          tryParse()
        })
      }
    }

    readHeader()
  })
}

function sendMessage(obj) {
  const json = JSON.stringify(obj)
  const buf = Buffer.from(json, "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(buf.length, 0)
  process.stdout.write(header)
  process.stdout.write(buf)
}

async function main() {
  process.stdin.resume()

  try {
    const msg = await readMessage()
    if (!msg) process.exit(0)

    if (msg.action === "WRITE_USAGE") {
      if (!fs.existsSync(USAGE_DIR)) {
        fs.mkdirSync(USAGE_DIR, { recursive: true })
      }
      fs.writeFileSync(USAGE_FILE, JSON.stringify(msg.payload, null, 2), "utf-8")
      sendMessage({ success: true, path: USAGE_FILE })
    } else {
      sendMessage({ error: "Unknown action: " + msg.action })
    }
  } catch (err) {
    sendMessage({ error: String(err) })
  }

  process.exit(0)
}

main()
