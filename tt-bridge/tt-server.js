#!/usr/bin/env node
"use strict"

const http = require("http")
const fs = require("fs")
const path = require("path")
const os = require("os")

const USAGE_FILE = path.join(os.homedir(), ".token-tracker", "usage.json")
const PORT = 9898

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === "POST" && req.url === "/update") {
    let body = ""
    req.on("data", d => body += d)
    req.on("end", () => {
      try {
        fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true })
        fs.writeFileSync(USAGE_FILE, body)
        res.writeHead(200)
        res.end("ok")
      } catch (e) {
        res.writeHead(500)
        res.end(e.message)
      }
    })
    return
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200)
    res.end(JSON.stringify({ status: "ok", pid: process.pid }))
    return
  }

  res.writeHead(404)
  res.end()

}).listen(PORT, "127.0.0.1", () => {
  console.log(`[tt-server] listening on http://127.0.0.1:${PORT}`)
  console.log(`[tt-server] writing to ${USAGE_FILE}`)
})

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
