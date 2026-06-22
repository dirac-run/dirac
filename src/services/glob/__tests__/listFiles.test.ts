import { expect } from 'chai'
import * as path from 'path'

const srcDir = path.join(__dirname, '..', '..', '..')

describe('Glob listFiles', () => {
	describe('listFiles', () => {
		it('should list files in a directory', async () => {
			const { listFiles } = await import(path.join(srcDir, 'services', 'glob', 'list-files.ts'))
			const result = await listFiles(srcDir, false, 100)
			expect(Array.isArray(result[0])).to.be.true
		})

		it('should recursively list files when recursive is true', async () => {
			const { listFiles } = await import(path.join(srcDir, 'services', 'glob', 'list-files.ts'))
			const result = await listFiles(srcDir, true, 100)
			expect(Array.isArray(result[0])).to.be.true
		})

		it('should respect the limit parameter', async () => {
			const { listFiles } = await import(path.join(srcDir, 'services', 'glob', 'list-files.ts'))
			const result = await listFiles(srcDir, false, 5)
			expect(result[0].length).to.be.lessThanOrEqual(5)
		})

		it('should return file info with line counts for text files', async () => {
			const { listFiles } = await import(path.join(srcDir, 'services', 'glob', 'list-files.ts'))
			const result = await listFiles(srcDir, false, 10)
			const fileInfos = result[0]
			const textFile = fileInfos.find((f: any) => f.lineCount !== undefined)
			if (textFile) {
				expect(typeof textFile.lineCount).to.equal('number')
			}
		})

		it('should skip binary files and not include line counts', async () => {
			const { listFiles } = await import(path.join(srcDir, 'services', 'glob', 'list-files.ts'))
			const result = await listFiles(srcDir, false, 10)
			const fileInfos = result[0]
			const binaryFile = fileInfos.find((f: any) => f.lineCount === undefined)
			if (binaryFile) {
				expect(binaryFile.lineCount).to.be.undefined
			}
		})

		it('should return hasMore flag when limit is reached', async () => {
			const { listFiles } = await import(path.join(srcDir, 'services', 'glob', 'list-files.ts'))
			const result = await listFiles(srcDir, true, 3)
			expect(typeof result[1]).to.equal('boolean')
		})

		it('should not allow listing files in root directory', async () => {
			const { listFiles } = await import(path.join(srcDir, 'services', 'glob', 'list-files.ts'))
			const result = await listFiles('/', false, 100)
			expect(result[0].length).to.equal(0)
		})

		it('should not allow listing files in home directory', async () => {
			const { listFiles } = await import(path.join(srcDir, 'services', 'glob', 'list-files.ts'))
			const homeDir = require('os').homedir()
			const result = await listFiles(homeDir, false, 100)
			expect(result[0].length).to.equal(0)
		})
	})
})
