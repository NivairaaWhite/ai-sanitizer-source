// Real ProseMirror (what ChatGPT's and Claude's composers are built on), bundled for the mock page.
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from 'prosemirror-schema-basic';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';

window.__mountPM = function (mount, onSend) {
  const state = EditorState.create({
    schema,
    plugins: [
      history(),
      keymap({
        Enter: () => {
          onSend();
          return true;
        },
        'Mod-z': undo,
        'Mod-y': redo
      }),
      keymap(baseKeymap)
    ]
  });
  const view = new EditorView(mount, { state });
  view.dom.id = 'composer';
  view.dom.setAttribute('role', 'textbox');
  return {
    read: () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'),
    clear: () => view.dispatch(view.state.tr.delete(0, view.state.doc.content.size))
  };
};
