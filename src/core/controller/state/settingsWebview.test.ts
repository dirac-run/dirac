import { expect } from "chai"
import { describe, it } from "mocha"
import { Settings as ProtoSettings, UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { getDefaultValue } from "@shared/storage/state-keys"
import { buildWebviewSettingsPatch } from "./settingsWebview"

describe("low-verbosity settings", () => {
	it("is enabled by default", () => {
		expect(getDefaultValue("lowVerbosityEnabled")).to.equal(true)
	})

	it("maps explicit enabled and disabled webview updates", () => {
		expect(buildWebviewSettingsPatch(UpdateSettingsRequest.create({ lowVerbosityEnabled: true }))).to.include({
			lowVerbosityEnabled: true,
		})
		expect(buildWebviewSettingsPatch(UpdateSettingsRequest.create({ lowVerbosityEnabled: false }))).to.include({
			lowVerbosityEnabled: false,
		})
	})

	it("maps Utility permission enable, disable, and policy clearing exactly", () => {
		expect(
			buildWebviewSettingsPatch(
				UpdateSettingsRequest.create({
					utilityModelUsePermissionHandling: true,
					utilityModelPermissionPolicy: "Allow repository edits.",
				}),
			),
		).to.include({
			utilityModelUsePermissionHandling: true,
			utilityModelPermissionPolicy: "Allow repository edits.",
		})
		expect(
			buildWebviewSettingsPatch(
				UpdateSettingsRequest.create({
					utilityModelUsePermissionHandling: false,
					utilityModelPermissionPolicy: "",
				}),
			),
		).to.include({
			utilityModelUsePermissionHandling: false,
			utilityModelPermissionPolicy: "",
		})
	})
})

describe("retired completion-check settings", () => {
	it("ignores legacy JSON settings and updates without dropping supported fields", () => {
		const legacy = { doubleCheckCompletionEnabled: true, lowVerbosityEnabled: true }
		const settings = ProtoSettings.fromJSON(legacy)
		const request = UpdateSettingsRequest.fromJSON(legacy)

		expect(settings).not.to.have.property("doubleCheckCompletionEnabled")
		expect(request).not.to.have.property("doubleCheckCompletionEnabled")
		expect(buildWebviewSettingsPatch(request)).to.deep.equal({ lowVerbosityEnabled: true })
		expect(buildWebviewSettingsPatch({ ...request, ...legacy })).to.deep.equal({ lowVerbosityEnabled: true })
	})

	it("ignores the retired protobuf field numbers", () => {
		// Settings field 176 and UpdateSettingsRequest field 41, each encoded as true.
		const settings = ProtoSettings.decode(Uint8Array.from([0x80, 0x0b, 0x01]))
		const request = UpdateSettingsRequest.decode(Uint8Array.from([0xc8, 0x02, 0x01]))

		expect(settings).not.to.have.property("doubleCheckCompletionEnabled")
		expect(request).not.to.have.property("doubleCheckCompletionEnabled")
		expect(buildWebviewSettingsPatch(request)).to.deep.equal({})
	})
})
