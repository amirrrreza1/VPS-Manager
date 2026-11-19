export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutomationWorker } = await import("./lib/automation");
    startAutomationWorker();
  }
}
