const $ = (s) => document.querySelector(s);
let accounts = [];
async function message(data) {
  const result = await chrome.runtime.sendMessage(data);
  if (result.error) throw Error(result.error);
  return result;
}
function render(result) {
  accounts = result.accounts;
  $("#pair-form").hidden = true;
  $("#connected").hidden = false;
  $("#status").textContent = accounts.length
    ? "Paired. Choose the account you want to track."
    : "Paired. Add a Browser connection in the dashboard first.";
  $("#provider").replaceChildren(
    ...accounts.map((a) => {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.name;
      return o;
    }),
  );
  $("#pick").disabled = !accounts.length;
}
try {
  render(await message({ type: "status" }));
} catch (e) {
  $("#status").textContent =
    "Start the dashboard, then get a pairing code from Browser connection.";
  $("#pair-form").hidden = false;
}
$("#pair-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    render(await message({ type: "pair", code: $("#code").value.trim() }));
    $("#error").textContent = "";
  } catch (err) {
    $("#error").textContent = err.message;
  }
};
$("#pick").onclick = async () => {
  try {
    const account = accounts.find((a) => a.id === $("#provider").value);
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const url = new URL(tab.url);
    if (url.protocol !== "https:" || !account.hosts.includes(url.hostname))
      throw Error("Open this provider’s billing page in the active tab first.");
    const granted = await chrome.permissions.request({
      origins: [url.origin + "/*"],
    });
    if (!granted) throw Error("Page access is needed to read this balance.");
    await message({ type: "pick", provider: account.id, tabId: tab.id });
    window.close();
  } catch (e) {
    $("#error").textContent = e.message;
  }
};
