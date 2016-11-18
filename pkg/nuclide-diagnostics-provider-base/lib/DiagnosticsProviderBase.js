'use strict';
'use babel';

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.DiagnosticsProviderBase = undefined;

var _atom = require('atom');

var _TextEventDispatcher;

function _load_TextEventDispatcher() {
  return _TextEventDispatcher = _interopRequireDefault(require('./TextEventDispatcher'));
}

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const UPDATE_EVENT = 'update';
const INVALIDATE_EVENT = 'invalidate';

let _textEventDispatcherInstance = null;

function getTextEventDispatcher() {
  if (_textEventDispatcherInstance == null) {
    _textEventDispatcherInstance = new (_TextEventDispatcher || _load_TextEventDispatcher()).default();
  }
  return _textEventDispatcherInstance;
}

let DiagnosticsProviderBase = exports.DiagnosticsProviderBase = class DiagnosticsProviderBase {

  constructor(options) {
    let textEventDispatcher = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : getTextEventDispatcher();

    this._textEventDispatcher = textEventDispatcher;
    this._emitter = new _atom.Emitter();
    this._disposables = new _atom.CompositeDisposable();

    this._textEventCallback = callbackOrNoop(options.onTextEditorEvent);
    this._newUpdateSubscriberCallback = callbackOrNoop(options.onNewUpdateSubscriber);
    this._newInvalidateSubscriberCallback = callbackOrNoop(options.onNewInvalidateSubscriber);

    // The Set constructor creates an empty Set if passed null or undefined.
    this._grammarScopes = new Set(options.grammarScopes);
    this._allGrammarScopes = Boolean(options.enableForAllGrammars);
    this._subscribeToTextEditorEvent(Boolean(options.shouldRunOnTheFly));
  }

  /**
   * Subscribes to the appropriate event depending on whether we should run on
   * the fly or not.
   */


  // callbacks provided by client
  _subscribeToTextEditorEvent(shouldRunOnTheFly) {
    this._disposeEventSubscription();
    const dispatcher = this._textEventDispatcher;
    let subscription;
    if (shouldRunOnTheFly) {
      if (this._allGrammarScopes) {
        subscription = dispatcher.onAnyFileChange(this._textEventCallback);
      } else {
        subscription = dispatcher.onFileChange(this._grammarScopes, this._textEventCallback);
      }
    } else {
      if (this._allGrammarScopes) {
        subscription = dispatcher.onAnyFileSave(this._textEventCallback);
      } else {
        subscription = dispatcher.onFileSave(this._grammarScopes, this._textEventCallback);
      }
    }
    this._currentEventSubscription = subscription;
  }

  setRunOnTheFly(runOnTheFly) {
    this._subscribeToTextEditorEvent(runOnTheFly);
  }

  dispose() {
    this._emitter.dispose();
    this._disposables.dispose();
    this._disposeEventSubscription();
  }

  _disposeEventSubscription() {
    if (this._currentEventSubscription) {
      this._currentEventSubscription.dispose();
      this._currentEventSubscription = null;
    }
  }

  getGrammarScopes() {
    return this._grammarScopes;
  }

  /**
   * Clients can call these methods to publish messages
   */

  publishMessageUpdate(update) {
    this._emitter.emit(UPDATE_EVENT, update);
  }

  publishMessageInvalidation(message) {
    this._emitter.emit(INVALIDATE_EVENT, message);
  }

  /**
   * Clients should delegate to these
   */

  onMessageUpdate(callback) {
    const disposable = this._emitter.on(UPDATE_EVENT, callback);
    this._newUpdateSubscriberCallback(callback);
    return disposable;
  }

  onMessageInvalidation(callback) {
    const disposable = this._emitter.on(INVALIDATE_EVENT, callback);
    this._newInvalidateSubscriberCallback(callback);
    return disposable;
  }
};


function callbackOrNoop(callback) {
  return callback ? callback.bind(undefined) : () => {};
}