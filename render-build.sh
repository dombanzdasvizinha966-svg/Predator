#!/usr/bin/env bash
set -e
npm install
export PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR
npx puppeteer install chrome