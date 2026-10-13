const vscode = require("vscode");
const { createServer, newToken } = require("./server");

const PROMPT_JUSTIFICATION =
  "Pixel Helper builds Choreograph pixel configs from the page data you inspect in Chrome.";
let server;
let status;
let retry;

const config = () => vscode.workspace.getConfiguration("pixelHelperBridge");

async function pickModel() {
  const family = config().get("model");
  const models = await vscode.lm.selectChatModels({
    vendor: "copilot",
    ...(family ? { family } : {}),
  });
  return models[0];
}

function toError(error) {
  if (error instanceof vscode.LanguageModelError) {
    const hint =
      error.code === "NoPermissions"
        ? 'Copilot access was not granted. Run "Pixel Helper: Authorize Copilot" in VS Code once.'
        : error.message;
    return Object.assign(new Error(hint), { code: error.code });
  }
  return error;
}

async function generate(prompt, onChunk, signal) {
  const model = await pickModel().catch((error) => {
    throw toError(error);
  });
  if (!model)
    throw Object.assign(
      new Error("No Copilot model is available. Is GitHub Copilot signed in?"),
      { code: "NoModel" },
    );

  const cancellation = new vscode.CancellationTokenSource();
  signal.addEventListener("abort", () => cancellation.cancel());
  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: PROMPT_JUSTIFICATION },
      cancellation.token,
    );
    for await (const fragment of response.text) onChunk(fragment);
  } catch (error) {
    throw toError(error);
  } finally {
    cancellation.dispose();
  }
}

async function listModels() {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  return models.map((m) => ({ id: m.id, name: m.name, family: m.family }));
}

function start(context) {
  stop();
  const port = config().get("port");
  let token = context.globalState.get("token");
  if (!token) {
    token = newToken();
    context.globalState.update("token", token);
  }
  server = createServer({ getToken: () => token, generate, listModels });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      // Another VS Code window serves the bridge (the token is shared); take over if it closes.
      status.text = `$(plug) Pixel Helper :${port} (other window)`;
      status.tooltip =
        "Another VS Code window is serving the bridge. This window takes over if that one closes.";
      retry = setTimeout(() => start(context), 5000);
      return;
    }
    status.text = "$(error) Pixel Helper bridge";
    status.tooltip = error.message;
    vscode.window.showErrorMessage(
      `Pixel Helper bridge could not start: ${error.message}`,
    );
  });
  server.listen(port, "127.0.0.1", () => {
    status.text = `$(plug) Pixel Helper :${port}`;
    status.tooltip = "Click to copy the bridge token for the Chrome extension";
  });
}

function stop() {
  clearTimeout(retry);
  if (server) server.close();
  server = undefined;
}

function activate(context) {
  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    0,
  );
  status.command = "pixelHelperBridge.copyToken";
  status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("pixelHelperBridge.copyToken", async () => {
      await vscode.env.clipboard.writeText(
        context.globalState.get("token") || "",
      );
      vscode.window.showInformationMessage(
        "Bridge token copied. Paste it into the Copilot tab of the Pixel Helper panel.",
      );
    }),
    // Copilot asks for consent on the first request, and that dialog needs a user-initiated action.
    vscode.commands.registerCommand("pixelHelperBridge.authorize", async () => {
      try {
        await generate(
          "Reply with the single word OK.",
          () => {},
          new AbortController().signal,
        );
        vscode.window.showInformationMessage(
          "Copilot access works. Pixel Helper can use it.",
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Copilot access failed: ${error.message}`,
        );
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pixelHelperBridge.port")) start(context);
    }),
    { dispose: stop },
  );
  start(context);
}

module.exports = { activate, deactivate: stop };
