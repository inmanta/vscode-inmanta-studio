//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');

/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
        path: path.resolve(__dirname, 'out'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
    },
    externals: {
        vscode: 'commonjs vscode',
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [{ loader: 'ts-loader' }],
            },
        ],
    },
    devtool: 'source-map',
    infrastructureLogging: {
        level: 'log',
    },
};

/** @type WebpackConfig */
const webviewConfig = {
    target: 'web',
    mode: 'none',
    entry: {
        webview: './src/webview/main.ts',
        onboarding: './src/webview/onboarding/main.ts',
    },
    output: {
        path: path.resolve(__dirname, 'out'),
        filename: '[name].js',
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: { 'fa-icon-trees$': 'react-icons/fa' },
    },
    plugins: [
        // The icons of react-icons without React: GenIcon hands back the svg tree of the icon
        new webpack.NormalModuleReplacementPlugin(/react-icons[\\/]lib[\\/]index\.mjs$/, path.resolve(__dirname, 'src/webview/iconShim.js')),
    ],
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [{ loader: 'ts-loader', options: { configFile: path.resolve(__dirname, 'src/webview/tsconfig.json') } }],
            },
            {
                test: /\.css$/,
                type: 'asset/source',
            },
            {
                test: /\.woff2$/,
                type: 'asset/inline',
            },
        ],
    },
    devtool: 'source-map',
    performance: { hints: false },
};

module.exports = [extensionConfig, webviewConfig];
