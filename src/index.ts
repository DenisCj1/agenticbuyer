 
export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "AgenticBuyer",
				version: "0.1.0"
			});
		}

		return Response.json({
			name: "AgenticBuyer",
			message: "AgenticBuyer is online.",
			status: "building",
			version: "0.1.0"
		});
	},
} satisfies ExportedHandler<Env>;