#!/usr/bin/env bash
# Common repo-root resolution for Hubble scripts (scripts/ lives one level down).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
