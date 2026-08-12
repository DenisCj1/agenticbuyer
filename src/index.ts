 import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
	const server = new McpServer({
		name: "AgenticBuyer",
		version: "0.2.0",
	});

	server.registerTool(
		"buyer_ping",
		{
			description: "Check that the AgenticBuyer MCP service is online.",
			inputSchema: {
				message: z.string().optional(),
			},
		},
		async ({ message }) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						service: "AgenticBuyer",
						status: "online",
						message: message ?? "AgenticBuyer MCP is working.",
					}),
				},
			],
		}),
	);

	return server;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "AgenticBuyer",
				version: "0.2.0",
			});
		}

		if (url.pathname === "/mcp") {
			return createMcpHandler(createServer)(request, env, ctx);
		}

		return Response.json({
			name: "AgenticBuyer",
			message: "AgenticBuyer is online.",
			status: "building",
			version: "0.2.0",
			mcp: "/mcp",
		});
	},
} satisfies ExportedHandler<Env>;