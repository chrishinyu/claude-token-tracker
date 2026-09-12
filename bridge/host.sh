#!/bin/bash
exec /usr/local/bin/node "$(dirname "$0")/host.js" "$@"
