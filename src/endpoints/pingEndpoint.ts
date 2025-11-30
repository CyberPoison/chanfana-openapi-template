import { contentJson, OpenAPIRoute } from "chanfana";
import { AppContext } from "../types";
import { z } from "zod";

export class PingEndpoint extends OpenAPIRoute {
  public schema = {
    tags: ["Network"],
    summary: "Fetch OAuth2.json from dev.opendrive.com and measure response times",
    operationId: "ping-opendrive",
    request: {
      query: z.object({
        samples: z.string().optional().default("5").describe("Number of samples to collect (1-10)"),
      }),
    },
    responses: {
      "200": {
        description: "Returns network metrics including latency, IP, jitter, response size, etc.",
        ...contentJson({
          success: z.boolean(),
          result: z.object({
            target: z.string(),
            url: z.string(),
            ip: z.string().nullable(),
            timestamp: z.string(),
            metrics: z.object({
              samples: z.number(),
              minLatency: z.number().describe("Minimum latency in ms"),
              maxLatency: z.number().describe("Maximum latency in ms"),
              avgLatency: z.number().describe("Average latency in ms"),
              jitter: z.number().describe("Jitter (standard deviation) in ms"),
              packetLoss: z.number().describe("Packet loss percentage"),
              avgResponseSize: z.number().describe("Average response size in bytes"),
            }),
            individualResults: z.array(
              z.object({
                attempt: z.number(),
                success: z.boolean(),
                latency: z.number().nullable(),
                statusCode: z.number().nullable(),
                responseSize: z.number().nullable().describe("Response size in bytes"),
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
    const url = `https://${target}/api/resources/oauth2.json`;
    
    // Parse and validate samples parameter
    let samples = parseInt(data.query.samples || "5");
    samples = Math.min(Math.max(samples, 1), 10); // Clamp between 1 and 10

    const results: Array<{
      attempt: number;
      success: boolean;
      latency: number | null;
      statusCode: number | null;
      responseSize: number | null;
      error: string | null;
    }> = [];

    let ipAddress: string | null = null;

    // First, try to resolve the IP address using DNS API
    try {
      const dnsResponse = await fetch(`https://1.1.1.1/dns-query?name=${target}&type=A`, {
        headers: { 'Accept': 'application/dns-json' }
      });
      if (dnsResponse.ok) {
        const dnsData = await dnsResponse.json() as any;
        if (dnsData.Answer && dnsData.Answer.length > 0) {
          ipAddress = dnsData.Answer[0].data;
        }
      }
    } catch (error) {
      // If DNS lookup fails, continue without IP
      console.log("DNS lookup failed:", error);
    }

    // Perform multiple GET requests to fetch the JSON
    for (let i = 0; i < samples; i++) {
      const attempt = i + 1;
      const startTime = Date.now();
      
      try {
        const response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });
        
        const responseText = await response.text();
        const endTime = Date.now();
        const latency = endTime - startTime;
        const responseSize = new TextEncoder().encode(responseText).length;

        // Success means we got a 2xx response and could fetch the content
        const isSuccess = response.ok;

        results.push({
          attempt,
          success: isSuccess,
          latency,
          statusCode: response.status,
          responseSize,
          error: isSuccess ? null : `HTTP ${response.status}: ${response.statusText}`,
        });
      } catch (error) {
        const endTime = Date.now();
        const latency = endTime - startTime;
        
        results.push({
          attempt,
          success: false,
          latency,
          statusCode: null,
          responseSize: null,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }

      // Small delay between requests to avoid overwhelming the target
      if (i < samples - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Fallback IP if DNS lookup failed
    if (!ipAddress) {
      ipAddress = "N/A (resolved by Cloudflare)";
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

    // Calculate average response size
    const responseSizes = successfulResults
      .map(r => r.responseSize)
      .filter((size): size is number => size !== null);
    const avgResponseSize = responseSizes.length > 0
      ? responseSizes.reduce((a, b) => a + b, 0) / responseSizes.length
      : 0;

    return {
      success: true,
      result: {
        target,
        url,
        ip: ipAddress,
        timestamp: new Date().toISOString(),
        metrics: {
          samples,
          minLatency: parseFloat(minLatency.toFixed(2)),
          maxLatency: parseFloat(maxLatency.toFixed(2)),
          avgLatency: parseFloat(avgLatency.toFixed(2)),
          jitter: parseFloat(jitter.toFixed(2)),
          packetLoss: parseFloat(packetLoss.toFixed(2)),
          avgResponseSize: Math.round(avgResponseSize),
        },
        individualResults: results,
      },
    };
  }
}

