'use strict';

const heatmiser = require('heatmiser');
const semver = require('semver');

const devices = [];
let tempDevices = [];

let neoBridge;

/**
 * Driver start up, re-initialize devices
 * that were already installed before driver
 * shutdown
 * @param devicesData
 * @param callback
 */
module.exports.init = (devicesData, callback) => {
	devicesData.forEach(deviceData => {
		addDevice(deviceData);
	});
	return callback(null, true);
};

/**
 * Default pairing process
 */
module.exports.pair = socket => {

	socket.on('list_devices', (data, callback) => {

		tempDevices = [];

		// Pairing timeout
		const timeout = setTimeout(() => callback(null, []), 15000);

		const searchBridge = new heatmiser.Neo();
		searchBridge.on('ready', (host, port, discoveredDevices) => {

			// Clear timeout
			clearTimeout(timeout);

			// Check for each device if it is already installed, or should be
			discoveredDevices.forEach(device => {
				const generatedDeviceID = generateDeviceID(device.device, device.DEVICE_TYPE);
				tempDevices.push({
					id: generatedDeviceID,
					name: device.device,
					data: {
						pairedWithAppVersion: Homey.manifest.version,
						id: generatedDeviceID,
						bridgeIP: host
					}
				});
			});

			return callback(null, tempDevices);
		});
	});
};

module.exports.added = (deviceData, callback) => {

	// Store device as installed
	addDevice(deviceData);

	if (callback) callback(null, true);
};

/**
 * These represent the capabilities of the Heatmiser Neo Smart
 */
module.exports.capabilities = {

	target_temperature: {

		get: (deviceData, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Retrieve updated data
			fetchData(deviceData, () => {
				const device = getDevice(deviceData);
				if (!device) return callback(deviceData);
				return callback(null, device.state.targetTemperature);
			});
		},

		set: (deviceData, temperature, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Get device data
			const device = getDevice(deviceData);
			if (!device) return callback(device);

			// Catch faulty trigger and max/min temp
			if (!temperature) {
				return callback('missing_temperature_parameter');
			}
			else if (temperature < 5) {
				temperature = 5;
			}
			else if (temperature > 35) {
				temperature = 35;
			}

			neoBridge.setTemperature(Math.round(temperature), device.name, err => {
				if (err) console.log(err);
				if (callback) return callback(err, temperature);
			});
		}
	},

	measure_temperature: {

		get: (deviceData, callback) => {
			if (deviceData instanceof Error) return callback(deviceData);

			// Retrieve updated data
			fetchData(deviceData, () => {

				// Get device data
				const device = getDevice(deviceData);
				if (!device) return callback(device);

				// Callback measured temperature
				return callback(null, device.state.measureTemperature);
			});
		}
	}
};

/**
 * Delete devices internally when users removes one
 * @param deviceData
 */
module.exports.deleted = deviceData => {
	for (let x = 0; x < devices.length; x++) {
		if (devices[x].data.id === deviceData.id) {
			clearInterval(devices[x].pollInterval);
			devices.splice(x, 1);
			break;
		}
	}
};

/**
 * Adds the device to the installed devices list if it's not already on there.
 * If it is initialising (e.g. after reboot of Homey). Set the device id to the correct place.
 * @param deviceData
 */
function addDevice(deviceData) {

	const device = {
		state: {
			targetTemperature: null,
			measureTemperature: null,
		},
		data: deviceData,
	};

	if (!neoBridge) neoBridge = new heatmiser.Neo(deviceData.bridgeIP);

	devices.push(device);

	// Check if device needs to be re-paired
	if (typeof deviceData.pairedWithAppVersion === 'undefined' || semver.lt(deviceData.pairedWithAppVersion, '1.1.4')) {
		module.exports.setUnavailable(deviceData, __('re_pair_needed'));
	}

	// Start listening for changes on target and measured temperature
	startPolling(deviceData);
}

/**
 * Heatmiser doesn't support realtime, therefore we have to poll
 * for changes considering the measured and target temperature
 */
function startPolling(deviceData) {
	const device = getDevice(deviceData);
	device.pollInterval = setInterval(() => {
		fetchData(deviceData);
	}, 15000);
}

/**
 * Gets the device from the given list
 * @param deviceData
 * @returns {*}
 */
function getDevice(deviceData) {
	if (devices.length > 0) {
		for (let x = 0; x < devices.length; x++) {
			if (devices[x].data.id === deviceData.id) {
				return devices[x];
			}
		}
	} else return null;
}

/**
 * Request new information from neoBridge and update
 * it internally
 * @param callback
 */
function fetchData(deviceData, callback) {

	// Make sure driver properly started
	if (neoBridge && deviceData) {

		// Request updated information
		neoBridge.info(data => {
			if (data && Array.isArray(data.devices)) {
				data.devices.forEach(hubDevice => {

					const device = getDevice({ id: generateDeviceID(hubDevice.device, hubDevice.DEVICE_TYPE) });

					// Skip all devices which are not the device within the current scope
					if (device && generateDeviceID(hubDevice.device, hubDevice.DEVICE_TYPE) === deviceData.id) {

						module.exports.realtime(deviceData, 'target_temperature', hubDevice.CURRENT_SET_TEMPERATURE);
						module.exports.realtime(deviceData, 'measure_temperature', (Math.round(hubDevice.CURRENT_TEMPERATURE * 10) / 10));

						// Update internal data
						device.name = hubDevice.device; // Needed for the set-temperature function. Removed after reboot. Homey only holds IDs of items.
						device.state.targetTemperature = hubDevice.CURRENT_SET_TEMPERATURE;
						device.state.measureTemperature = (Math.round(hubDevice.CURRENT_TEMPERATURE * 10) / 10);
					}
				});
			}
			if (callback) return callback();
		});
	}
}

/**
 * Generates a unique ID based on two input parameters
 * @param param1
 * @param param2
 * @returns {string} unique device ID
 */
function generateDeviceID(param1, param2) {
	return new Buffer(param1 + param2).toString('base64');
}