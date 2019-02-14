import * as vscode from "vscode";
import debounce = require("lodash.debounce");
import { decorate, initDecorator } from "./decorator";
import { Note } from "./note";
import {
  isNotePath,
  watchCorrespondingNotes,
  getCorrespondingNotes,
  removeNotCorrespondingNotes
} from "./noteUtil";

export const activate = (context: vscode.ExtensionContext) => {
  let disposed: boolean = false;

  const decorateDebounce = debounce(() => {
    if (disposed) {
      return;
    }
    decorate();
  }, 500);
  decorateDebounce();

  // watch note files
  let unwatch: (() => void) | undefined;
  const watch = async () => {
    if (unwatch) {
      unwatch();
      unwatch = void 0;
    }
    if (disposed) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const fsPath = editor.document.uri.fsPath;
      if (!(await isNotePath(fsPath))) {
        unwatch = await watchCorrespondingNotes(fsPath, decorateDebounce);
      }
    }
  };
  watch();

  // watch notes that are not corresponding files
  const automaticallyDelete = async () => {
    if (disposed) {
      return;
    }
    const enable = vscode.workspace
      .getConfiguration()
      .get("linenote.automaticallyDelete");
    if (enable) {
      const interval = vscode.workspace
        .getConfiguration()
        .get("linenote.automaticallyDeleteInterval");
      if (typeof interval === "number" && interval >= 0) {
        const start = +new Date();
        await removeNotCorrespondingNotes();
        const duration = +new Date() - start;
        setTimeout(automaticallyDelete, Math.max(0, interval - duration));
      }
    }
  };
  automaticallyDelete();

  // get [from, to] from editor.selection
  const getSelectionLineRange = (
    editor: vscode.TextEditor
  ): [number, number] => {
    return [
      // add 1 because editor's line number starts with 1, not 0
      editor.selection.start.line + 1, // from
      editor.selection.end.line + 1 // to
    ];
  };

  context.subscriptions.push(
    new vscode.Disposable(() => (disposed = true)),

    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        watch();
        decorateDebounce();
      }
    }),

    vscode.workspace.onDidChangeTextDocument(event => {
      if (
        vscode.window.activeTextEditor &&
        event.document === vscode.window.activeTextEditor.document
      ) {
        decorateDebounce();
      }
    }),

    vscode.workspace.onDidCloseTextDocument(async event => {
      // remove note if it is empty
      const fsPath = event.uri.fsPath;
      if (await isNotePath(fsPath)) {
        const notePath = fsPath;
        const note = await Note.fromNotePath(notePath);
        const body = await note.read();
        if (!body.trim().length) {
          await note.remove();
        }
      }
    }),

    vscode.workspace.onDidChangeConfiguration(async event => {
      if (
        event.affectsConfiguration("linenote.lineColor") ||
        event.affectsConfiguration("linenote.rulerColor")
      ) {
        await initDecorator();
        await decorate();
      }
      // linenote.automaticallyDelete is no need to check
      // because it is checked on 'automaticallyDelete'
    }),

    vscode.commands.registerCommand("linenote.addNote", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const fsPath = editor.document.uri.fsPath;
        // do not create notes of notes
        if (await isNotePath(fsPath)) {
          return;
        }
        const [from, to] = getSelectionLineRange(editor);
        const note = await Note.fromFsPath(fsPath, from, to);

        // create empty note if it does not exist
        if (!(await note.noteExists())) {
          await note.write("");
        }
        await note.open();
      }
    }),

    vscode.commands.registerCommand(
      "linenote.openNote",
      async (notePath?: string) => {
        const editor = vscode.window.activeTextEditor;
        if (notePath) {
          // open specified note (when invoked from the hover text)
          const note = await Note.fromNotePath(notePath);
          await note.open();
        } else if (editor) {
          // open all notes at current cursor (when invoked from the command palette)
          const fsPath = editor.document.uri.fsPath;
          if (await isNotePath(fsPath)) {
            return;
          }
          const notes = await getCorrespondingNotes(fsPath);
          const [from, to] = getSelectionLineRange(editor);
          await Promise.all(
            notes
              .filter(note => note.isOverlapped(from, to))
              .map(async note => await note.open())
          );
        }
      }
    ),

    vscode.commands.registerCommand(
      "linenote.removeNote",
      async (notePath?: string) => {
        const editor = vscode.window.activeTextEditor;
        if (notePath) {
          // remove specified note (when invoked from the hover text)
          const note = await Note.fromNotePath(notePath);
          await note.remove();
          decorateDebounce();
        } else if (editor) {
          // remove one note at current cursor (when invoked from the command palette)
          const fsPath = editor.document.uri.fsPath;
          if (await isNotePath(fsPath)) {
            return;
          }
          const notes = await getCorrespondingNotes(fsPath);
          const [from, to] = getSelectionLineRange(editor);
          const note = notes.find(note => note.isOverlapped(from, to));
          if (note) {
            await note.remove();
            decorateDebounce();
          }
        }
      }
    ),

    vscode.commands.registerCommand(
      "linenote.revealLine",
      async ({
        fsPath,
        from,
        to
      }: {
        fsPath: string;
        from: number;
        to: number;
      }) => {
        console.log(fsPath);
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          if (editor.document.uri.fsPath !== fsPath) {
            await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
          }

          const selection = new vscode.Range(
            // subtract 1 because api's line number starts with 0, not 1
            editor.document.lineAt(from - 1).range.start,
            editor.document.lineAt(to - 1).range.end
          );

          await vscode.window.showTextDocument(editor.document, {
            selection
          });
        }
      }
    )
  );
};
