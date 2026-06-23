# IMPORTANT: `npm run postpublish` to update this file after publishing a new version of the package
class Dirac < Formula
  desc "Autonomous coding agent CLI - capable of creating/editing files, running commands, and more"
  homepage "https://dirac.run"
  url "https://registry.npmjs.org/dirac-cli/-/dirac-cli-0.4.7.tgz" # GET from https://registry.npmjs.org/dirac-cli/latest tarball URL
  sha256 "bf79e3f588d269027e53c3b39504e842f557cc4a950a2b4d3b12764751bb9752"
  license :cannot_represent

  depends_on "node@20"
  depends_on "ripgrep"

  def install
    system "npm", "install", *std_npm_args(prefix: false)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Test that the binary exists and is executable
    assert_match version.to_s, shell_output("#{bin}/dirac --version")
  end
end
