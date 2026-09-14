{
  lib,
  stdenvNoCC,
  jq,
}:

# The plugin is source only. Paseo compiles the TypeScript itself and supplies
# every module it imports at runtime, which is why `paseo-plugin.json` declares
# no `build` and why this derivation runs no package manager: an npm tree here
# would be dead weight the daemon never reads. `package.json` is carried along
# for its version and for the typecheck a developer runs from a clone, not for
# anything the daemon resolves.
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "paseo-github-integration";
  version = "1.0.1";

  # A file set rather than the directory: the repository root is also the plugin
  # root now, so `node_modules`, the lockfile, the docs screenshots, the flake
  # and the Markdown around them would otherwise all land in the store path the
  # daemon reads — and a local `npm install` would change this derivation's hash.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../paseo-plugin.json
      ../package.json
      ../index.client.tsx
      ../index.server.ts
      ../client
      ../server
      ../shared
    ];
  };

  nativeBuildInputs = [ jq ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    # The runtime plugin id is the config key the daemon looks the plugin up by,
    # so a manifest that drifted from the name this package is wired under would
    # fail at daemon start instead of here.
    id=$(jq -r .id paseo-plugin.json)
    if [ "$id" != "github-integration" ]; then
      echo "paseo-plugin.json declares id '$id', expected 'github-integration'" >&2
      exit 1
    fi

    mkdir -p "$out"
    cp -r . "$out/"

    runHook postInstall
  '';

  meta = {
    description = "GitHub issues, pull requests, projects and review inside Paseo";
    homepage = "https://github.com/alysnnix/paseo-github-integration";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
})
