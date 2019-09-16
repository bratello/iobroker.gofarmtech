'use strict';

const util 			  = require('util');
const mqtt            = require('mqtt-connection');
const EventEmitter 	  = require('events');
const state2string    = require(__dirname + '/common').state2string;
const convertTopic2id = require(__dirname + '/common').convertTopic2id;
const convertID2topic = require(__dirname + '/common').convertID2topic;
const makePayload 	  = require(__dirname + '/common').makePayload;

function getLog(msg) {
	let data = `GoFarmTechServer: ${msg}`;
	if(arguments.length > 1) {
		data += ', arguments: ' + Array.prototype.slice.call(arguments, 1).map( item => JSON.stringify(item)).join(", ");
	}
	return data;
}

class GoFarmTechServer extends EventEmitter {
	constructor(adapter) {
		super();
		this.adapter = adapter;
		this.clients = new Proxy({}, (() => {
			let doUpdateClients = (clients) => {
				let text = '';
				if(clients) {
					for(let id in clients) {
						if(clients.hasOwnProperty(id)) {
							text += (text ? ',' : '') + id;
						}
					}
				}
				this.adapter.setState('info.connection', {val: text, ack: true});
			};
			let handler = {
				set: function (clients, id, client) {
					clients[id] = client;
					doUpdateClients(clients);
					// Indicate success
	    			return true;
				},
				deleteProperty: function (clients, id) {
					if(id in clients) {
						delete clients[id];
						doUpdateClients(clients);
					}
					return true;
				}
			};
			doUpdateClients();
			return handler;
		})());
		this.adapter.setObjectNotExistsPromise = util.promisify(this.adapter.setObjectNotExists);
		this.adapter.setStatePromise = util.promisify(this.adapter.setState);
		this.cronHandle = null;
		this.cronJobs = [];
		this.server = null;
	}

	destroy() {
		this.info('destroy');
		this.stopCron();
	}

	get net() {
		if(!GoFarmTechServer.net)
			GoFarmTechServer.net = require('net');
		return GoFarmTechServer.net;
	}

	get config() {
		return this.adapter.config;
	}

	get DEVICES() {
		return 'devices';
	}

	get logLevel() {
		return {
			info: this.adapter.config.logLevel & 1,
			warn: this.adapter.config.logLevel & 2,
			error: this.adapter.config.logLevel & 4
		};
	}

	info(msg) {
		if(this.logLevel.info)
			this.adapter.log.info(getLog.apply(this, arguments));
	}

	warn(msg) {
		if(this.logLevel.warn)
			this.adapter.log.warn(getLog.apply(this, arguments));
	}

	error(msg, err) {
		if(this.logLevel.error)
			this.adapter.log.error(getLog(msg, err.message));
	}

	stopCron() {
		if(this.cronHandle) {
			clearInterval(this.cronHandle);
			this.cronHandle = null;
		}
		this.cronJobs = [];
	}

	startCron() {
		this.stopCron();
		this.cronHandle = setInterval(() => {
			let now = Math.round(Date.now()/1000);
			this.cronJobs.forEach((job) => {
				if(job.running) {
					return;
				}
				if(now < job.lastExecTime + job.timeout) {
					return;
				}
				job.running = true;
				job.lastError = null;
				try {
					job.task();
				} catch(err) {
					this.error('Cron task error', err);
					job.lastError = err;
				}
				job.lastExecTime = now;
				job.running = false;
			});
		}, this.config.cronTimeout * 1000);
	}

	scheduleCronTask(timeout, task) {
		this.cronJobs.push({
			task: task,
			running: false,
			timeout: timeout,
			lastExecTime: 0,
			lastError: null
		});
	}

	scheduleTimersUpdate(anClient) {
		this.info('scheduleTimersUpdate');
		let getDateNow = () => {
			var date = new Date();
			return Math.round(date.getTime() / 1000) - (date.getTimezoneOffset() * 60);
		};
		let updateClient = (client, dateVal) => {
			if(client.timerAvailable) {
				client.publishTimerValue(dateVal);
			}
		};
		if(anClient) {
			updateClient(anClient, getDateNow());
			return;
		}

		this.scheduleCronTask(this.config.timersUpdateInterval, () => {
			this.info('timersUpdate Handler');
			var dateVal = getDateNow();
			for(let id in this.clients) {
				updateClient(this.clients[id], dateVal);
			}
		});
	}

	async deviceDefinition(deviceId, deviceHome, data) {
		const TimerValue = 'TimerValue';
		const types = ['boolean', 'string', 'number', 'array', 'object', 'mixed'];

		function getAttributeRole(attr, path) {
			let type = (attr.tp in types ? types[attr.tp] : 'mixed');
			let role = 'switch';
			if(attr.ac === 0) {
				role = 'sensor';
				if(attr.nm === 'LastError') {
					role = 'error';
				}
			} else {
				if(type === 'number') {
					role = 'indicator';
					if(attr.nm === TimerValue) {
						role = 'timer';
					}
				} else if(type !== 'number' && type !== 'boolean') {
					role = 'info';
					if(path.lastIndexOf(TimerValue) === path.length - TimerValue.length) {
						role = 'task';
					}
				}
			}
			return role;
		}

		let defineAttribute = async (attr, path) => {
			let attrPath = `${path}.${attr.nm}`;
			let role = getAttributeRole(attr, path);
			await this.adapter.setObjectNotExistsPromise(attrPath, {
				type: 'state',
				common: {
					name: attr.nm,
					role: role,
					type: (attr.tp in types ? types[attr.tp] : 'mixed'),
					read: attr.ac !== 1,
					write: attr.ac > 0
				},
				native: {}
			});

			await this.adapter.setStatePromise(attrPath, {
				val: attr.v,
				ack: true
			});
		};

		let defineAttributes = async (attrs, path) => {
			for(let i = 0; i < attrs.length; i++) {
				await defineAttribute(attrs[i], path);
			}
		};

		let defineValue = async (val, path) => {
			let valPath = `${path}.${val.nm}`;
			await defineAttribute(val, path);
			if(val.ats) {
				await defineAttributes(val.ats, valPath);
			}
			if(val.its) {
				for(let i = 0; i < val.its.length; i++) {
					await defineValue(val.its[i], valPath);
				}
			}
		};

		try {
			await this.adapter.setObjectNotExistsPromise(deviceHome, {
				type: 'state',
				common: {
					name: `${data.nm} Device`,
					type: 'object',
					role: 'meta'
				},
				native: {}
			});
			await this.adapter.setStatePromise(deviceHome, {
				val: data,
				ack: true
			});
			await defineAttributes(data.ats, deviceHome);
			for(let i = 0; i < data.its.length; i++) {
				await defineValue(data.its[i], deviceHome);
			}
		} catch(err) {
			this.error('Device definition failed', err);
		}
	}

	initialize() {
		this.info('initialize');
		this.startCron();
		this.scheduleTimersUpdate();
		this.subscribeDevices();
		this.server = new this.net.Server();
		this.server.on('connection', stream => {
			let client = mqtt(stream);

			client.closeClient = () => {
				delete this.clients[client.id];
				client.destroy();
			};

			client.publishPromise = util.promisify(client.publish);

			client.publishPayload = (payload, qos) => {
				qos = qos || 0;
				let data = payload.serialize();
				return client.publishPromise({
					topic: client.deviceTopic,
					payload: data,
					qos
				}).catch((err) => {
					this.error('publishPayload failed', err);
				});
			};

			client.publishTimerValue = function (val) {
    			client.publishPayload(makePayload('TimerValue', val));
			};

			client.on('connect', options => {
				this.info('Client connected', options);
				client.id = options.clientId;
				client._deviceHome = `${this.DEVICES}.${client.id}`;
				client.descriptionTopic = `GoFarmTechClient/${client.id}`;
				client.deviceTopic = `${client.descriptionTopic}/subscribe`;
				client.clientTopic = `${client.descriptionTopic}/publish`;
				client._hasDefinition = false;
				this.adapter.getObject(client._deviceHome, (err, obj) => {
					if(!err && obj) {
						this.info('Definition = ', obj);
						client._hasDefinition = true;
					} else {
						this.info('Definition still not exists', (err ? err.message : obj));
					}
				});
				let oldClient = this.clients[client.id];
				if (this.config.user) {
					if(this.config.user !== options.username || this.config.pass !== options.password) {
						this.warn(`Client [${client.id}]  has invalid password(${options.password}) or username(${options.username})`);
						client.connack({returnCode: 4});
						if(oldClient) {
							delete this.clients[client.id];
							oldClient.destroy();
						}
						client.destroy();
                        return;
					}
				}
				if(oldClient) {
					oldClient.destroy();
				}
				// acknowledge the connect packet
    			client.connack({ returnCode: 0 });
    			this.clients[client.id] = client;
			});

			// client published
			client.on('publish', packet => {
				this.info('Client publish', packet.topic);
				let data = packet.payload.toString('utf8');

				try {
					data = JSON.parse(data);
				} catch (err) {
					this.error(`JSON error: ${data}`, err);
					return;
				}
				
				if(packet.topic === client.descriptionTopic) {
					//handle device description
					client.timerAvailable = data.its.find((item) => {
						return item.nm === 'TimerValue';
					}) ? true : false;
					this.scheduleTimersUpdate(client);
					this.deviceDefinition(client.id, client._deviceHome, data);
					client._hasDefinition = true;
				} else if(packet.topic === client.clientTopic && client._hasDefinition) {
					this.info('Payload: ', JSON.stringify(data));
					for(let key in data) {
						let val = data[key];
						let state = client._deviceHome + '.' + key.replace(/\//g, ".");
						this.adapter.setStatePromise(state, { 
							val: val,
							ack: true
						}).catch((err) => {
							this.error(`setState for state ${state} failed`, err);
						});
					}
				}
				// send a puback with messageId (for QoS > 0)
				if(packet.qos) {
					client.puback({ messageId: packet.messageId });
				}
			});

			// client pinged
			client.on('pingreq', () => {
				this.info('Client pingreq', arguments);
				// send a pingresp
				client.pingresp();
			});

			// client subscribed
			client.on('subscribe', packet => {
				this.info('Client subscribe', packet);
				// send a suback with messageId and granted QoS level
				client.suback({ granted: [packet.qos], messageId: packet.messageId });
			});

			// timeout idle streams after 5 minutes
			stream.setTimeout(1000 * this.config.connectionTimeout);

			// connection error handling
			client.on('close', (had_error) => { 
				this.info('Client close', had_error);
				client.closeClient(); 
			});
			client.on('error', (e) => { 
				this.info('Client error', e.message);
				client.closeClient(); 
			});
			client.on('disconnect', () => { 
				this.info('Client disconnect');
				client.closeClient(); 
			});

			// stream timeout
			stream.on('timeout', () => { 
				this.info('Stream timeout');
				client.closeClient(); 
			});
		});
		this.server.listen(this.config.port, () => {
			this.info(`Starting MQTT Server on port ${this.config.port}`);
		});
	}

	subscribeDevices() {
		const devicesFullPath = `${this.adapter.namespace}.${this.DEVICES}.`;
		const deviceIdFromStateId = (id) => {
			let deviceState = id.substring(devicesFullPath.length);
			let deviceId = deviceState.substring(0, deviceState.indexOf('.'));
			return deviceId;
		};
		const stateIdToTopic = (id) => {
			let deviceState = id.substring(devicesFullPath.length);
			return deviceState.substring(deviceState.indexOf('.') + 1).replace(/\./g, "/");
		};
		this.adapter.subscribeStates(`${this.DEVICES}.*`);
		this.adapter.on('stateChange', (id, state) => {
			// Warning, state can be null if it was deleted
			// you can use the ack flag to detect if it is status (true) or command (false)
			if (state && !state.ack) {
				let deviceId = deviceIdFromStateId(id);
				let topic = stateIdToTopic(id);
				//Check the device connected to adapter
				if(deviceId in this.clients) {
					let client = this.clients[deviceId];
					let val = state.val;
					if(Array.isArray(val) || val instanceof Object) {
						val = JSON.stringify(val);
					}
					client.publishPayload(makePayload(topic, val));
					//this.info('ack is not set!', id, topic);
				}
			}
		});
	}
}

GoFarmTechServer.net = null;

module.exports = GoFarmTechServer;