const { assert } = require('chai');

const sendData = require('../helpers/sendData');
const delayForDuration = require('../helpers/delayForDuration');
const { ServiceManagerTypes } = require('../helpers/serviceManager');
const catchDelayCancelError = require('../helpers/catchDelayCancelError');
const BroadlinkRMAccessory = require('./accessory');

class WindowCoveringAccessory extends BroadlinkRMAccessory {

  setDefaults () {
    const { config, state } = this;
    const { currentPosition, positionState } = state;
    const { initialDelay, percentageChangePerSend, totalDurationOpen, totalDurationClose } = config;

    // Check required propertoes
    assert.isNumber(totalDurationOpen, '`totalDurationOpen` is required and should be numeric.')
    assert.isNumber(totalDurationClose, '`totalDurationClose` is required and should be numeric.')

    // Set config default values
    if (!initialDelay) config.initialDelay = 0.1;

    // Set state default values
    if (currentPosition === undefined) this.state.currentPosition = 0;
    if (positionState === undefined) this.state.positionState = Characteristic.PositionState.STOPPED;
  }

  reset () {
    this.clearAllExistingTimers();
  }

  async clearAllExistingTimers () {
    // Clear existing timeouts
    if (this.initialDelayPromise) {
      this.initialDelayPromise.cancel();
      this.initialDelayPromise = null;
    }
    
    if (this.updateCurrentPositionPromise) {
      this.updateCurrentPositionPromise.cancel();
      this.updateCurrentPositionPromise = null;
    }
    
    if (this.autoStopPromise) {
      this.autoStopPromise.cancel();
      this.autoStopPromise = null;
    }

    // Clear Multi-hex timeouts
    if (this.intervalTimeoutPromise) {
      this.intervalTimeoutPromise.cancel();
      this.intervalTimeoutPromise = null;
    }

    if (this.pauseTimeoutPromise) {
      this.pauseTimeoutPromise.cancel();
      this.pauseTimeoutPromise = null;
    }
  }

  // User requested a specific position or asked the window-covering to be open or closed
  async setTargetPosition (hexData, previousValue) {
    await this.setTargetPositionActual();
  }

  async setTargetPositionActual (hexData, previousValue) {
    const { config, host, debug, data, log, name, state, serviceManager } = this;
    const { initialDelay, percentageChangePerSend } = config;
    const { open, close, stop } = data;
    
    this.clearAllExistingTimers();

    // Ignore if no change to the targetPosition
    if (state.targetPosition === previousValue) return;

    // `initialDelay` allows multiple `window-covering` accessories to be updated at the same time
    // without RF interference by adding an offset to each `window-covering` accessory
    this.initialDelayPromise = delayForDuration(initialDelay);
    await this.initialDelayPromise;

    if (this.checkOpenOrCloseCompletely()) return;

    log(`${name} setTargetPosition: (currentPosition: ${state.currentPosition})`);

    // Determine if we're opening or closing
    let difference = state.targetPosition - state.currentPosition;

    state.opening = (difference > 0);
    if (!state.opening) difference = -1 * difference;

    log(`${name} setTargetPosition: (percentageChangePerSend: ${percentageChangePerSend})`);
    
    hexData = state.opening ? open : close

    // Perform the actual open/close asynchronously i.e. without await so that HomeKit status can be updated
    this.openOrClose({ hexData, previousValue });
  }

  async openOrClose ({ hexData, previousValue }) {
    let { config, data, host, name, log, state, debug, serviceManager } = this;
    let { totalDurationOpen, totalDurationClose } = config;
    const { stop } = data;

    const newPositionState = state.opening ? Characteristic.PositionState.INCREASING : Characteristic.PositionState.DECREASING;
    serviceManager.setCharacteristic(Characteristic.PositionState, newPositionState);

    log(`${name} setTargetPosition: currently ${state.currentPosition}%, moving to ${state.targetPosition}%`);

    this.performSend(hexData);

    let difference = state.targetPosition - state.currentPosition
    if (!state.opening) difference = -1 * difference;

    const fullOpenCloseTime = state.opening ? totalDurationOpen : totalDurationClose;
    const durationPerPercentage = fullOpenCloseTime / 100;
    const totalTime = durationPerPercentage * difference;

    log(`${name} setTargetPosition: ${totalTime}s (${fullOpenCloseTime} / 100 * ${difference}) until auto-stop`);

    this.startUpdatingCurrentPositionAtIntervals();

    this.autoStopPromise = delayForDuration(totalTime);
    await this.autoStopPromise;

    this.stopWindowCovering();

    serviceManager.setCharacteristic(Characteristic.CurrentPosition, state.targetPosition);
  }

  stopWindowCovering () {
    const { data, host, log, name, state, debug, serviceManager } = this;
    const { stop } = data;
  
    log(`${name} setTargetPosition: (stop window covering)`);

    // Reset the state and timers
    this.reset();

    sendData({ host, hexData: stop, log, name, debug });

    serviceManager.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);
  }

  checkOpenOrCloseCompletely () {
    const { data, debug, host, log, name, serviceManager, state } = this;
    const { openCompletely, closeCompletely } = data;

    // Completely Close
    if (state.targetPosition === 0 && closeCompletely) {
      serviceManager.setCharacteristic(Characteristic.CurrentPosition, state.targetPosition);

      sendData({ host, hexData: closeCompletely, log, name, debug });

      this.stopWindowCovering();

      return true;
    }

    // Completely Open
    if (state.targetPosition === 100 && openCompletely) {
      serviceManager.setCharacteristic(Characteristic.CurrentPosition, state.targetPosition);

      sendData({ host, hexData: openCompletely, log, name, debug });

      this.stopWindowCovering();

      return true;
    }

    return false;
  }

    // Determine how long it should take to increase/decrease a single %
  determineOpenCloseDurationPerPercent ({ opening, totalDurationOpen, totalDurationClose  }) {
    assert.isBoolean(opening);
    assert.isNumber(totalDurationOpen);
    assert.isNumber(totalDurationClose);
    assert.isAbove(totalDurationOpen, 0);
    assert.isAbove(totalDurationClose, 0);

    const fullOpenCloseTime = opening ? totalDurationOpen : totalDurationClose;
    const durationPerPercentage = fullOpenCloseTime / 100;

    return durationPerPercentage;
  }

  async startUpdatingCurrentPositionAtIntervals () {
    catchDelayCancelError(async () => {
      const { config, serviceManager, state } = this;
      const { totalDurationOpen, totalDurationClose } = config;
      
      const durationPerPercentage = this.determineOpenCloseDurationPerPercent({ opening: state.opening, totalDurationOpen, totalDurationClose })

      // Wait for a single % to increase/decrease
      this.updateCurrentPositionPromise = delayForDuration(durationPerPercentage)
      await this.updateCurrentPositionPromise

      // Set the new currentPosition
      let currentValue = state.currentPosition || 0;

      if (state.opening) currentValue++;
      if (!state.opening) currentValue--;

      serviceManager.setCharacteristic(Characteristic.CurrentPosition, currentValue);

      // Let's go again
      this.startUpdatingCurrentPositionAtIntervals();
    });
  }

  async performSend (hexData) {
    const { debug, config, host, log, name } = this;

    if (typeof hexData === 'string') {
      sendData({ host, hexData, log, name, debug });

      return;
    }

    await catchDelayCancelError(async () => {
      // Itterate through each hex config in the array
      for (let index = 0; index < hexData.length; index++) {
        const { pause } = hexData[index]

        await this.performRepeatSend(hexData[index]);

        if (pause) {
          this.pauseTimeoutPromise = delayForDuration(pause);
          await this.pauseTimeoutPromise;
        }
      }
    });
  }

  async performRepeatSend (hexConfig) {
    const { host, log, name, debug } = this;
    let { data, interval, sendCount } = hexConfig;

    interval = interval || 1;

    // Itterate through each hex config in the array
    for (let index = 0; index < sendCount; index++) {
      sendData({ host, hexData: data, log, name, debug });

      if (index < sendCount - 1) {
        this.intervalTimeoutPromise = delayForDuration(interval);
        await this.intervalTimeoutPromise;
      }
    }
  }

  setupServiceManager () {
    const { data, log, name, serviceManagerType } = this;

    this.serviceManager = new ServiceManagerTypes[serviceManagerType](name, Service.WindowCovering, log);

    this.serviceManager.addToggleCharacteristic({
      name: 'currentPosition',
      type: Characteristic.CurrentPosition,
      bind: this,
      getMethod: this.getCharacteristicValue,
      setMethod: this.setCharacteristicValue,
      props: {

      }
    });

    this.serviceManager.addToggleCharacteristic({
      name: 'positionState',
      type: Characteristic.PositionState,
      bind: this,
      getMethod: this.getCharacteristicValue,
      setMethod: this.setCharacteristicValue,
      props: {

      }
    });

    this.serviceManager.addToggleCharacteristic({
      name: 'targetPosition',
      type: Characteristic.TargetPosition,
      bind: this,
      getMethod: this.getCharacteristicValue,
      setMethod: this.setCharacteristicValue,
      props: {
        setValuePromise: this.setTargetPosition.bind(this)
      }
    });
  }
}

module.exports = WindowCoveringAccessory;
