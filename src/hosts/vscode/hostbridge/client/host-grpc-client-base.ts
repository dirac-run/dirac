import { v4 as uuidv4 } from "uuid"
import { StreamingCallbacks } from "@/hosts/host-provider-types"
import { GrpcHandler } from "@/hosts/vscode/hostbridge-grpc-handler"
import { Logger } from "@/shared/services/Logger"

// Generic type for any protobuf service definition
export type ProtoService = {
	name: string
	fullName: string
	methods: {
		[key: string]: {
			name: string
			requestType: any
			responseType: any
			requestStream: boolean
			responseStream: boolean
			options: any
		}
	}
}

// Define a unified client type that handles both unary and streaming methods
export type GrpcClientType<T extends ProtoService> = {
	[K in keyof T["methods"]]: T["methods"][K]["responseStream"] extends true
		? (
				request: InstanceType<T["methods"][K]["requestType"]>,
				options: StreamingCallbacks<InstanceType<T["methods"][K]["responseType"]>>,
			) => () => void // Returns a cancel function
		: (request: InstanceType<T["methods"][K]["requestType"]>) => Promise<InstanceType<T["methods"][K]["responseType"]>>
}

// Create a client for any protobuf service with inferred types
export function createGrpcClient<T extends ProtoService>(service: T): GrpcClientType<T> {
	const client: Record<string, Function> = {}
	const grpcHandler = new GrpcHandler()

	Object.values(service.methods).forEach((method) => {
		// Use lowercase method name as the key in the client object
		const methodKey = method.name.charAt(0).toLowerCase() + method.name.slice(1)

		// Streaming method implementation
		if (method.responseStream) {
			client[methodKey] = (request: any, options: StreamingCallbacks<InstanceType<typeof method.responseType>>) => {
				// Use dispatchGrpcMethod with streaming callbacks
				const requestId = uuidv4()

				// We need to await the promise and then return the cancel function
				return (async () => {
					try {
						const result = await grpcHandler.dispatchGrpcMethod<InstanceType<typeof method.responseType>>(
							service.fullName,
							methodKey,
							request,
							requestId,
							options,
						)

						// If the result is a function, it's the cancel function
						if (typeof result === "function") {
							return result
						}
						// This shouldn't happen, but just in case
						Logger.error(`Expected cancel function but got response object for streaming request: ${requestId}`)
						return () => {}
					} catch (error) {
						Logger.error(`Error in streaming request: ${error}`)
						if (options.onError) {
							options.onError(error instanceof Error ? error : new Error(String(error)))
						}
						return () => {}
					}
				})()
			}
		} else {
			// Unary method implementation
			client[methodKey] = async (request: any) => {
				const requestId = uuidv4()
				try {
					const response = await grpcHandler.dispatchGrpcMethod(service.fullName, methodKey, request, requestId)

					// Check if the response is a function (streaming)
					if (typeof response === "function") {
						// This shouldn't happen for unary requests
						throw new Error("Received streaming response for unary request")
					}
					return response
				} catch (e) {
					Logger.log(`[DEBUG] gRPC host ERR to ${service.fullName}.${methodKey} req:${requestId} err:${e}`)
					throw e
				}
			}
		}
	})
	return client as GrpcClientType<T>
}
