'use strict';
/**
 * Vercel Serverless Function entrypoint.
 * Exports the Express application instance.
 */
const { app } = require('../server');

module.exports = app;
