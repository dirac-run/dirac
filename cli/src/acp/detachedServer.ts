import net from "node:net";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import { DiracAgent } from "../agent/DiracAgent.js";
import type { AcpAgentOptions, PermissionHandler } from "../agent/types.js";
import { AcpAgent } from "./AcpAgent.js";
import {
	createResilientNdJsonStream,
	nodeToWebReadable,
	nodeToWebWritable,
} from "./streamUtils.js";

export interface DetachedAcpServer {
	close(): Promise<void>;
}

/**
 * Serve ACP on a Unix socket while retaining one DiracAgent across client connections.
 * A transport disconnect only releases its listeners; sessions and in-flight turns stay alive.
 */
export async function listenForDetachedAcp(
	options: AcpAgentOptions & { socketPath: string },
): Promise<DetachedAcpServer> {
	const agent = new DiracAgent({ ...options, detached: true });
	let activeConnection: { socket: net.Socket; transport: AcpAgent } | undefined;
	let permissionOwner: AcpAgent | undefined;
	let activePermission:
		| {
			request: Parameters<PermissionHandler>[0];
			resolve: Parameters<PermissionHandler>[1];
		}
		| undefined;
	let pendingPermission:
		| {
			request: Parameters<PermissionHandler>[0];
			resolve: Parameters<PermissionHandler>[1];
		}
		| undefined;

	const retainPermission: PermissionHandler = (request, resolve) => {
		pendingPermission = { request, resolve };
		permissionOwner = undefined;
	};
	const deliverPermission = (
		transport: AcpAgent,
		request: Parameters<PermissionHandler>[0],
		resolve: Parameters<PermissionHandler>[1],
	): void => {
		permissionOwner = transport;
		activePermission = { request, resolve };
		transport
			.requestPermission(request)
			.then((response) => {
				if (permissionOwner !== transport) return;
				permissionOwner = undefined;
				activePermission = undefined;
				resolve(response);
			})
			.catch(() => {
				if (permissionOwner !== transport) return;
				activePermission = undefined;
				retainPermission(request, resolve);
			});
	};
	const transferPermission = (transport: AcpAgent): void => {
		if (pendingPermission) {
			const pending = pendingPermission;
			pendingPermission = undefined;
			deliverPermission(transport, pending.request, pending.resolve);
			return;
		}
		if (!permissionOwner || !activePermission) return;
		const active = activePermission;
		permissionOwner = undefined;
		activePermission = undefined;
		deliverPermission(transport, active.request, active.resolve);
	};
	const transportPermissionHandler =
		(transport: AcpAgent): PermissionHandler =>
			(request, resolve) =>
				deliverPermission(transport, request, resolve);

	agent.setPermissionHandler(retainPermission);
	const server = net.createServer((socket) => {
		const previousConnection = activeConnection;
		previousConnection?.transport.disconnect();
		previousConnection?.socket.destroy();

		let transport!: AcpAgent;
		new AgentSideConnection(
			(connection) => {
				transport = new AcpAgent(
					connection,
					options,
					agent,
					transportPermissionHandler(transport),
				);
				activeConnection = { socket, transport };
				agent.setPermissionHandler(transportPermissionHandler(transport));
				return transport;
			},
			createResilientNdJsonStream(
				nodeToWebWritable(socket),
				nodeToWebReadable(socket),
			),
		);
		queueMicrotask(() => transferPermission(transport));

		socket.once("close", () => {
			if (activeConnection?.socket !== socket) {
				transport?.disconnect();
				return;
			}
			activeConnection = undefined;
			agent.setPermissionHandler(retainPermission);
			transport.disconnect();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		async close(): Promise<void> {
			activeConnection?.transport.disconnect();
			activeConnection?.socket.destroy();
			activeConnection = undefined;
			if (pendingPermission) {
				const pending = pendingPermission;
				pendingPermission = undefined;
				permissionOwner = undefined;
				pending.resolve({ outcome: { outcome: "cancelled" } });
			}
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await agent.shutdown();
		},
	};
}
