import net from "node:net";

async function canListen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function pickCdpPort(preferredPort = 9222): Promise<number> {
  if (await canListen(preferredPort)) return preferredPort;

  // Fall back to any free port.
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate free port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

