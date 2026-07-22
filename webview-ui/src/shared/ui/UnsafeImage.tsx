import type { ComponentProps } from "react"
import React, { useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/shared/ui/button"

type UnsafeImageProps = ComponentProps<"img">

const UnsafeImage: React.FC<UnsafeImageProps> = ({ src = "", alt = "", className, onError, ...imgProps }) => {
	const [approvedSrc, setApprovedSrc] = useState<string>()
	const [failedSrc, setFailedSrc] = useState<string>()
	const isApproved = approvedSrc === src

	if (!src) return null

	if (!isApproved && !src.startsWith("data:")) {
		return (
			<span className="my-2 flex min-w-0 flex-col rounded-md border border-input-border bg-code p-3">
				<span className="m-0 block text-sm font-medium">External image blocked pending consent</span>
				<span className="mt-2 mb-0 block break-all text-xs text-muted-foreground">
					Source: <code>{src}</code>
					{alt && (
						<>
							<br />
							Alt: <code>{alt}</code>
						</>
					)}
				</span>
				<Button className="mt-3 self-start" onClick={() => setApprovedSrc(src)} type="button" variant="outline">
					Load image
				</Button>
			</span>
		)
	}

	if (failedSrc === src) {
		return (
			<output className="my-2 block min-w-0 rounded-md border border-error/30 bg-error/5 p-3 text-xs text-error">
				Image could not be loaded{alt ? `: ${alt}` : "."}
			</output>
		)
	}

	return (
		<img
			{...imgProps}
			alt={alt}
			className={cn("block h-auto max-w-full object-contain", className)}
			decoding={imgProps.decoding ?? "async"}
			loading={imgProps.loading ?? "lazy"}
			onError={(event) => {
				setFailedSrc(src)
				onError?.(event)
			}}
			src={src}
		/>
	)
}

export default UnsafeImage
