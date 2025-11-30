import { contentJson, OpenAPIRoute } from "chanfana";
import { AppContext } from "../types";
import { z } from "zod";

export class PingEndpoint extends OpenAPIRoute {
  public schema = {
    tags: ["Network"],
    summary: "Ping dev.opendrive.com and return network metrics",
    operationId: "ping-opendrive",
    request: {
      query: z.object({
        samples: z.string().optional().default("5").describe("Number of ping samples to collect (1-10)"),
      }),
    },
    responses: {
      "200": {
        description: "Returns network metrics including latency, IP, jitter, etc.",
        ...contentJson({
          success: z.boolean(),
          result: z.object({
            target: z.string(),
            ip: z.string().nullable(),
            timestamp: z.string(),
            metrics: z.object({
              samples: z.number(),
              minLatency: z.number().describe("Minimum latency in ms"),
              maxLatency: z.number().describe("Maximum latency in ms"),
              avgLatency: z.number().describe("Average latency in ms"),
              jitter: z.number().describe("Jitter (standard deviation) in ms"),
              packetLoss: z.number().describe("Packet loss percentage"),
            }),
            individualResults: z.array(
              z.object({
                attempt: z.number(),
                success: z.boolean(),
                latency: z.number().nullable(),
                statusCode: z.number().nullable(),
                error: z.string().nullable(),
              })
            ),
          }),
        }),
      },
    },
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const target = "dev.opendrive.com";
    const url = `https://${target}`;
    
    // Parse and validate samples parameter
    let samples = parseInt(data.query.samples || "5");
    samples = Math.min(Math.max(samples, 1), 10); // Clamp between 1 and 10

    const results: Array<{
      attempt: number;
      success: boolean;
      latency: number | null;
      statusCode: number | null;
      error: string | null;
    }> = [];

    let ipAddress: string | null = null;

    // Perform multiple ping attempts
    for (let i = 0; i < samples; i++) {
      const attempt = i + 1;
      const startTime = Date.now();
      
      try {
        const response = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });
        
        const endTime = Date.now();
        const latency = endTime - startTime;

        // Try to get IP from response headers if available
        if (!ipAddress) {
          // Cloudflare Workers don't expose the resolved IP directly,
          // but we can note the CF-Connecting-IP or similar headers
          ipAddress = response.headers.get("CF-Connecting-IP") || 
                     response.headers.get("X-Real-IP") || 
                     "N/A (resolved by Cloudflare)";
        }

        results.push({
          attempt,
          success: response.ok,
          latency,
          statusCode: response.status,
          error: null,
        });
      } catch (error) {
        const endTime = Date.now();
        const latency = endTime - startTime;
        
        results.push({
          attempt,
          success: false,
          latency,
          statusCode: null,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }

      // Small delay between requests to avoid overwhelming the target
      if (i < samples - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Calculate metrics
    const successfulResults = results.filter(r => r.success && r.latency !== null);
    const latencies = successfulResults.map(r => r.latency!);
    
    const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
    const avgLatency = latencies.length > 0 
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
      : 0;

    // Calculate jitter (standard deviation)
    let jitter = 0;
    if (latencies.length > 1) {
      const variance = latencies.reduce((sum, lat) => {
        return sum + Math.pow(lat - avgLatency, 2);
      }, 0) / latencies.length;
      jitter = Math.sqrt(variance);
    }

    // Calculate packet loss
    const packetLoss = ((samples - successfulResults.length) / samples) * 100;

    return {
      success: true,
      result: {
        target,
        ip: ipAddress,
        timestamp: new Date().toISOString(),
        metrics: {
          samples,
          minLatency: parseFloat(minLatency.toFixed(2)),
          maxLatency: parseFloat(maxLatency.toFixed(2)),
          avgLatency: parseFloat(avgLatency.toFixed(2)),
          jitter: parseFloat(jitter.toFixed(2)),
          packetLoss: parseFloat(packetLoss.toFixed(2)),
        },
        individualResults: results,
      },
    };
  }
}

