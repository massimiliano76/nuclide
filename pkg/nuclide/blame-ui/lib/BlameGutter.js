'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */
import type {
  BlameForEditor,
  BlameInfo,
  BlameProvider,
} from 'nuclide-blame-base/lib/blame-types';

var {BLAME_DECORATION_CLASS} = require('./constants');
import {track, trackTiming} from 'nuclide-analytics';
var BLAME_GUTTER_DEFAULT_WIDTH = 50;
var LOADING_SPINNER_ID = 'blame-loading-spinner';
var MS_TO_WAIT_BEFORE_SPINNER = 2000;
var CHANGESET_CSS_CLASS = 'nuclide-blame-ui-hash';
var CLICKABLE_CHANGESET_CSS_CLASS = 'nuclide-blame-ui-hash-clickable';
var HG_CHANGESET_DATA_ATTRIBUTE = 'hgChangeset';

class BlameGutter {
  _editor: atom$TextEditor;
  _blameProvider: BlameProvider;
  _changesetSpanClassName: string;
  _bufferLineToDecoration: Map<number, atom$Decoration>;
  _gutter: atom$Gutter;
  _loadingSpinnerIsPending: boolean;
  _loadingSpinnerDiv: ?HTMLElement;
  _loadingSpinnerTimeoutId: number;
  _isDestroyed: boolean;

  /**
   * @param gutterName A name for this gutter. Must not be used by any another
   *   gutter in this TextEditor.
   * @param editor The TextEditor this BlameGutter should create UI for.
   * @param blameProvider The BlameProvider that provides the appropriate blame
   *   information for this BlameGutter.
   */
  constructor(gutterName: string, editor: atom$TextEditor, blameProvider: BlameProvider) {
    this._isDestroyed = false;

    this._editor = editor;
    this._blameProvider = blameProvider;
    this._changesetSpanClassName = CHANGESET_CSS_CLASS;
    this._bufferLineToDecoration = new Map();
    this._gutter = editor.addGutter({name: gutterName});
    this._updateGutterWidthToPixelWidth(BLAME_GUTTER_DEFAULT_WIDTH);

    // If getUrlForRevision() is available, add a single, top-level click handler for the gutter.
    if (typeof blameProvider.getUrlForRevision === 'function') {
      // We also want to style the changeset differently if it is clickable.
      this._changesetSpanClassName += ' ' + CLICKABLE_CHANGESET_CSS_CLASS;

      var onClick = this._onClick.bind(this);
      var gutterView: HTMLElement = atom.views.getView(this._gutter);
      gutterView.addEventListener('click', onClick);
      this._gutter.onDidDestroy(() => gutterView.removeEventListener('click', onClick));
    }

    this._fetchAndDisplayBlame();
  }

  /**
   * If the user clicked on a ChangeSet ID, extract it from the DOM element via the data- attribute
   * and find the corresponding Differential revision. If successful, open the URL for the revision.
   */
  async _onClick(e: MouseEvent): Promise<void> {
    var target = e.target;
    if (!target) {
      return;
    }

    var changeset = target.dataset[HG_CHANGESET_DATA_ATTRIBUTE];
    if (!changeset) {
      return;
    }

    var url = await this._blameProvider.getUrlForRevision(this._editor, changeset);
    if (url) {
      // Note that 'shell' is not the public 'shell' package on npm but an Atom built-in.
      require('shell').openExternal(url);
    } else {
      atom.notifications.addWarning(`No URL found for ${changeset}.`, {dismissable: true});
    }

    track('blame-gutter-click-revision', {
      editorPath: this._editor.getPath(),
      url,
    });
  }

  async _fetchAndDisplayBlame(): Promise<void> {
    // Add a loading spinner while we fetch the blame.
    this._addLoadingSpinner();

    var newBlame = await this._blameProvider.getBlameForEditor(this._editor);
    // The BlameGutter could have been destroyed while blame was being fetched.
    if (this._isDestroyed) {
      return;
    }

    // Remove the loading spinner before setting the contents of the blame gutter.
    this._cleanUpLoadingSpinner();

    this._updateBlame(newBlame);
  }

  _addLoadingSpinner(): void {
    if (this._loadingSpinnerIsPending) {
      return;
    }
    this._loadingSpinnerIsPending = true;
    this._loadingSpinnerTimeoutId = window.setTimeout(() => {
      this._loadingSpinnerIsPending = false;
      this._loadingSpinnerDiv = document.createElement('div');
      this._loadingSpinnerDiv.id = LOADING_SPINNER_ID;
      var gutterView = atom.views.getView(this._gutter);
      gutterView.appendChild(this._loadingSpinnerDiv);
    }, MS_TO_WAIT_BEFORE_SPINNER);
  }

  _cleanUpLoadingSpinner(): void {
    if (this._loadingSpinnerIsPending) {
      window.clearTimeout(this._loadingSpinnerTimeoutId);
      this._loadingSpinnerIsPending = false;
    }
    if (this._loadingSpinnerDiv) {
      this._loadingSpinnerDiv.remove();
      this._loadingSpinnerDiv = null;
    }
  }

  destroy(): void {
    this._isDestroyed = true;
    this._cleanUpLoadingSpinner();
    if (!this._editor.isDestroyed()) {
      // Due to a bug in the Gutter API, destroying a Gutter after the editor
      // has been destroyed results in an exception.
      this._gutter.destroy();
    }
    for (var decoration of this._bufferLineToDecoration.values()) {
      decoration.getMarker().destroy();
    }
  }

  // The BlameForEditor completely replaces any previous blame information.
  @trackTiming('blame-ui.blame-gutter.updateBlame')
  _updateBlame(blameForEditor: BlameForEditor): void {
    if (blameForEditor.size === 0) {
      atom.notifications.addInfo(
          `Found no blame to display. Is this file empty or untracked?
          If not, check for errors in the Nuclide logs local to your repo.`);
    }
    var allPreviousBlamedLines = new Set(this._bufferLineToDecoration.keys());

    var longestBlame = 0;
    for (var blameInfo of blameForEditor.values()) {
      var blameLength = blameInfo.author.length;
      if (blameInfo.changeset) {
        blameLength += blameInfo.changeset.length + 1;
      }
      if (blameLength > longestBlame) {
        longestBlame = blameLength;
      }
    }

    for (var [bufferLine, blameInfo] of blameForEditor) {
      this._setBlameLine(bufferLine, blameInfo, longestBlame);
      allPreviousBlamedLines.delete(bufferLine);
    }

    // Any lines that weren't in the new blameForEditor are outdated.
    for (var oldLine of allPreviousBlamedLines) {
      this._removeBlameLine(oldLine);
    }

    // Update the width of the gutter according to the new contents.
    this._updateGutterWidthToCharacterLength(longestBlame);
  }

  _updateGutterWidthToPixelWidth(pixelWidth: number): void {
    var gutterView = atom.views.getView(this._gutter);
    gutterView.style.width = `${pixelWidth}px`;
  }

  _updateGutterWidthToCharacterLength(characters: number): void {
    var gutterView = atom.views.getView(this._gutter);
    gutterView.style.width = `${characters}ch`;
  }

  _setBlameLine(bufferLine: number, blameInfo: BlameInfo, longestBlame: number): void {
    var item = this._createGutterItem(blameInfo, longestBlame);
    var decorationProperties = {
      type: 'gutter',
      gutterName: this._gutter.name,
      class: BLAME_DECORATION_CLASS,
      item,
    };

    var decoration = this._bufferLineToDecoration.get(bufferLine);
    if (!decoration) {
      var bufferLineHeadPoint = [bufferLine, 0];
      // The range of this Marker doesn't matter, only the line it is on, because
      // the Decoration is for a Gutter.
      var marker = this._editor.markBufferRange([bufferLineHeadPoint, bufferLineHeadPoint]);
      decoration = this._editor.decorateMarker(marker, decorationProperties);
      this._bufferLineToDecoration.set(bufferLine, decoration);
    } else {
      decoration.setProperties(decorationProperties);
    }
  }

  _removeBlameLine(bufferLine: number): void {
    var blameDecoration = this._bufferLineToDecoration.get(bufferLine);
    if (!blameDecoration) {
      return;
    }
    // The recommended way of destroying a decoration is by destroying its marker.
    blameDecoration.getMarker().destroy();
    this._bufferLineToDecoration.delete(bufferLine);
  }

  _createGutterItem(blameInfo: BlameInfo, longestBlame: number): HTMLElement {
    var doc = window.document;
    var item = doc.createElement('div');

    var authorSpan = doc.createElement('span');
    authorSpan.innerText = blameInfo.author;
    item.appendChild(authorSpan);

    if (blameInfo.changeset) {
      var numSpaces = longestBlame - blameInfo.author.length - blameInfo.changeset.length;
      // Insert non-breaking spaces to ensure the changeset is right-aligned.
      // Admittedly, this is a little gross, but it seems better than setting style.width on every
      // item that we create and having to give it a special flexbox layout. Hooray monospace!
      item.appendChild(doc.createTextNode('\u00A0'.repeat(numSpaces)));

      var changesetSpan = doc.createElement('span');
      changesetSpan.className = this._changesetSpanClassName;
      changesetSpan.dataset[HG_CHANGESET_DATA_ATTRIBUTE] = blameInfo.changeset;
      changesetSpan.innerText = blameInfo.changeset;
      item.appendChild(changesetSpan);
    }

    return item;
  }
}

module.exports = BlameGutter;
