'use strict';

/**
 * Dependencies
 */
var heatmiser = require('heatmiser');
var _ = require('underscore');

/**
 * Arrays used to store devices
 * @type {Array}
 */
var installed_devices = [];
var temp_devices = [];

/**
 * The Heatmiser Neo Smart client
 */
var neo;

/**
 * Driver start up, re-initialize devices
 * that were already installed before driver
 * shutdown
 * @param devices
 * @param callback
 */
module.exports.init = function (devices, callback) {

	console.log("Initialise Heatmiser");

	devices.forEach(function (device) {
		addDevice(device);
	});

	neo = new heatmiser.Neo();

	// Start listening for changes on target and measured temperature
	startPolling();

	// Success
	callback(null, true);
};

/**
 * Default pairing process
 */
module.exports.pair = function (socket) {

	socket.on("list_devices", function (data, callback) {

		// Pairing timeout
		var timeout = setTimeout(function () {
			return callback(null, []);
		}, 15000);

		neo = new heatmiser.Neo();

		// Found devices
		neo.on('ready', function (host, port, found_devices) {
			// Clear timeout
			clearTimeout(timeout);
			var devices = [];
			temp_devices = []; // Clear list of temporary devices before starting new pairing.

			// Check for each device if it is already installed, or should be
			found_devices.forEach(function (device) {
				var device_id = generateDeviceID(device.device, device.DEVICE_TYPE);

				// Check if we don't have the same device twice in the devices list
				if (!getDevice(device_id, devices) && !getDevice(device_id, temp_devices)) {

					// If the device wasn't installed before, add it to the temporary devices list.
					if (!_.findWhere(installed_devices, { id: device_id })) {
						temp_devices.push({
							id: device_id,
							name: device.device,
							data: {
								id: device_id,
								target_temperature: null, // Needs to be null so that item is directly visible after installation in insights
								measured_temperature: null // Needs to be null so that item is directly visible after installation in insights
							}
						});
					}
				}
			});

			// Loop through all temp_devices (new found devices) and add them to the devices list.
			var devices_list = [];
			temp_devices.forEach(function (temp_device) {
				devices_list.push({
					id: temp_device.id,
					data: {
						id: temp_device.data.id
					},
					name: temp_device.name
				});
			});

			callback(null, devices_list);
		});
	});

	socket.on("add_device", function (device, callback) {

		// Store device as installed
		addDevice(getDevice(device.data.id, temp_devices));

		if (callback) callback(null, true);
	});
};

/**
 * These represent the capabilities of the Heatmiser Neo Smart
 */
module.exports.capabilities = {

	target_temperature: {

		get: function (device, callback) {
			if (device instanceof Error) return callback(device);

			// Retrieve updated data
			updateDeviceData(function () {

				// Get device data
				var thermostat = getDevice(device.id, installed_devices);
				if (!thermostat) return callback(device);

				callback(null, thermostat.data.target_temperature);
			});
		},

		set: function (device, temperature, callback) {
			if (device instanceof Error) return callback(device);

			// Get device data
			var thermostat = getDevice(device.id, installed_devices);
			if (!thermostat) return callback(device);

			// Catch faulty trigger and max/min temp
			if (!temperature) {
				callback(true, temperature);
				return false;
			}
			else if (temperature < 5) {
				temperature = 5;
			}
			else if (temperature > 35) {
				temperature = 35;
			}

			// Tell thermostat to change the target temperature (Heatmiser can only work with whole numbers)
			var forDevice = [thermostat.name];
			neo.setTemperature(Math.round(temperature), forDevice, function (err) {

				console.log(err);

				// Return error/success to front-end
				if (callback) callback(err, temperature);
			});
		}
	},

	measure_temperature: {

		get: function (device, callback) {
			if (device instanceof Error) return callback(device);

			// Retrieve updated data
			updateDeviceData(function () {

				// Get device data
				var thermostat = getDevice(device.id, installed_devices);
				if (!thermostat) return callback(device);

				// Callback measured temperature
				callback(null, thermostat.data.measured_temperature);
			});
		}
	}
};

/**
 * Delete devices internally when users removes one
 * @param device_data
 */
module.exports.deleted = function (device_data) {

	// Remove ID from installed devices array
	for (var x = 0; x < installed_devices.length; x++) {
		if (installed_devices[x].data.id === device_data.id) {
			installed_devices.splice(x, 1);
			break; // break for loop since length has been modified (but we only have to remove one item, so this is ok.
		}
	}
};

/**
 * Adds the device to the installed devices list if it's not already on there.
 * If it is initialising (e.g. after reboot of Homey). Set the device id to the correct place.
 * @param deviceIn
 */
function addDevice(deviceIn) {

	var device_id = null;
	if (deviceIn.id !== null) {
		device_id = deviceIn.id;

		if (typeof deviceIn.data === "undefined" || typeof deviceIn.data.id === "undefined") {

			if (typeof deviceIn.data === "undefined") {
				deviceIn.data = {};
			}
			deviceIn.data.id = device_id;
		}
	}

	if (device_id === null) {
		device_id = generateDeviceID(deviceIn, deviceIn.DEVICE_TYPE);
	}

	if (!_.findWhere(installed_devices, { id: device_id })) {
		installed_devices.push(deviceIn);
	}
}

/**
 * Heatmiser doesn't support realtime, therefore we have to poll
 * for changes considering the measured and target temperature
 */
function startPolling() {

	// Poll every 15 seconds
	setInterval(function () {

		// Update device data
		updateDeviceData();

	}, 15000);
}

/**
 * Gets the device from the given list
 * @param device_id
 * @returns {*}
 */
function getDevice(device_id, list) {
	var devices = list ? list : installed_devices;

	if (devices.length > 0) {
		for (var x = 0; x < devices.length; x++) {
			if (devices[x].data.id === device_id) {
				return devices[x];
			}
		}
	}
};

/**
 * Request new information from neo and update
 * it internally
 * @param callback
 */
function updateDeviceData(callback) {

	// Make sure driver properly started
	if (neo) {

		// Request updated information
		neo.info(function (data) {
			if (data && devices) {

				// Store new available data for each device
				data.devices.forEach(function (device) {
					var internal_device = getDevice(generateDeviceID(device.device, device.DEVICE_TYPE), installed_devices);

					// Make sure device exists
					if (internal_device != null) {

						// Check if there is a difference
						if (internal_device.data.target_temperature != device.CURRENT_SET_TEMPERATURE) {

							// Trigger target temperature changed
							module.exports.realtime({ id: generateDeviceID(device.device, device.DEVICE_TYPE) }, "target_temperature", device.CURRENT_SET_TEMPERATURE);
						}

						// Check if there is a difference
						if ((Math.round(internal_device.data.measured_temperature * 10) / 10) != (Math.round(device.CURRENT_TEMPERATURE * 10) / 10)) {

							// Trigger measured temperature changed
							module.exports.realtime({ id: generateDeviceID(device.device, device.DEVICE_TYPE) }, "measure_temperature", (Math.round(device.CURRENT_TEMPERATURE * 10) / 10));
						}

						// Update internal data
						internal_device.name = device.device; // Needed for the set-temperature function. Removed after reboot. Homey only holds IDs of items.
						internal_device.data = {
							id: generateDeviceID(device.device, device.DEVICE_TYPE),
							target_temperature: device.CURRENT_SET_TEMPERATURE,
							measured_temperature: (Math.round(device.CURRENT_TEMPERATURE * 10) / 10)
						};
					}
				});
			}
			if (callback) callback();
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