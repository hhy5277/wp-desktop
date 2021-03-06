'use strict';

/**
 * External Dependencies
 */
const electron = require( 'electron' );
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const url = require( 'url' );
const debug = require( 'debug' )( 'desktop:runapp' );
const path = require( 'path' );

/**
 * Internal dependencies
 */
const Config = require( 'lib/config' );
const server = require( './server' );
const Settings = require( 'lib/settings' );
const settingConstants = require( 'lib/settings/constants' );
const cookieAuth = require( 'lib/cookie-auth' );
const appInstance = require( 'lib/app-instance' );
const platform = require( 'lib/platform' );
const System = require( 'lib/system' );

/**
 * Module variables
 */
var mainWindow = null;

function showAppWindow() {
	const preloadFile = path.resolve( path.join( __dirname, '..', '..', 'public_desktop', 'preload.js' ) );
	let appUrl = Config.server_url + ':' + Config.server_port;
	let lastLocation = skipCriticalStartupLocations( Settings.getSetting( settingConstants.LAST_LOCATION ) );

	if ( lastLocation && isValidLastLocation( lastLocation ) ) {
		appUrl += lastLocation;
	}

	debug( 'Loading app (' + appUrl + ') in mainWindow' );

	let config = Settings.getSettingGroup( Config.mainWindow, 'window', [ 'x', 'y', 'width', 'height' ] );
	config.webPreferences.preload = preloadFile;

	mainWindow = new BrowserWindow( config );

	cookieAuth( mainWindow, function() {
		mainWindow.webContents.send( 'cookie-auth-complete' );
	} );

	mainWindow.webContents.on( 'did-finish-load', function() {
		mainWindow.webContents.send( 'app-config', Config, Settings.isDebug(), System.getDetails() );

		const ipc = electron.ipcMain;
		ipc.on( 'mce-contextmenu', function( ev ) {
			mainWindow.send( 'mce-contextmenu', ev );
		});

	} );

	mainWindow.webContents.session.webRequest.onBeforeRequest( function( details, callback ) {
		if ( details.resourceType === 'script' && details.url.startsWith( 'http://' ) && ! details.url.startsWith( Config.server_url + ':' + Config.server_port + '/' ) ) {
			debug( 'Redirecting http request ' + details.url + ' to ' + details.url.replace( 'http', 'https' ) );
			callback( { redirectURL: details.url.replace( 'http', 'https' ) } );
		} else {
			callback( {} );
		}
	} );

	mainWindow.webContents.session.webRequest.onHeadersReceived( function( details, callback ) {
		// always allow previews to be loaded in iframes
		if ( details.resourceType === 'subFrame' ) {
			const headers = Object.assign( {}, details.responseHeaders );
			Object.keys( headers ).forEach( function ( name ) {
				if ( name.toLowerCase() === 'x-frame-options' ) {
					delete headers[ name ];
				}
			} );
			callback( {
				cancel: false,
				responseHeaders: headers
			} );
			return;
		}
		callback( { cancel: false } );
	} );

	mainWindow.loadURL( appUrl );
	//mainWindow.openDevTools();

	mainWindow.on( 'close', function() {
		let currentURL = mainWindow.webContents.getURL();
		let parsedURL = url.parse( currentURL );
		if ( isValidLastLocation( parsedURL.pathname ) ) {
			Settings.saveSetting( settingConstants.LAST_LOCATION, parsedURL.pathname );
		}
	} );

	mainWindow.on( 'closed', function() {
		debug( 'Window closed' );
		mainWindow = null;
	} );

	platform.setMainWindow( mainWindow );

	return mainWindow;
}

function startServer( started_cb ) {
	debug( 'App is ready, starting server' );

	server.start( app, function() {
		started_cb( showAppWindow() );
	} );
}

/**
 * Temp fix: this function modifies the location in order to skip the ones that
 * trigger a new login request (see https://github.com/Automattic/wp-desktop/issues/582)
 * To be removed as soon as a proper fix lands in Calypso.
 */
function skipCriticalStartupLocations ( loc ) {
	if ( typeof loc !== 'string' ) {
		return loc;
	}

	if ( loc.startsWith( '/block-editor/post/' ) ) {
		let newLoc = loc.substr(0, loc.lastIndexOf('/')).replace('/block-editor/post/', '/posts/');
		return newLoc;
	}

	if ( loc.startsWith( '/block-editor/page/' ) ) {
		let newLoc = loc.substr(0, loc.lastIndexOf('/')).replace('/block-editor/page/', '/pages/');
		return newLoc;
	}

	if ( loc.startsWith( '/customize/' ) ) {
		let newLoc = loc.replace('/customize/', '/posts/');
		return newLoc;
	}

	return loc;
}

function isValidLastLocation( loc ) {
	const invalids = [
		'/desktop/',     // Page shown when no Electron
		'/start'         // Don't attempt to resume the signup flow
	];

	if ( typeof loc !== 'string' ) {
		return false;
	}

	for ( let s of invalids ) {
		if ( loc.startsWith( s ) ) {
			return false;
		}
	}

	return true;
}

module.exports = function( started_cb ) {
	debug( 'Checking for other instances' );
	let boot;

	if ( appInstance.isSingleInstance() ) {
		if ( 'development' === process.env.NODE_ENV ) {
			debug( 'Skipping server initialization in dev mode' );

			boot = () => started_cb( showAppWindow() );
		} else {
			boot = () => startServer( started_cb );
		}

		debug( 'No other instances, waiting for app ready' );

		// Start the app window
		if ( app.isReady() ) {
			boot();
		} else {
			app.on( 'ready', boot );
		}
	}
};
