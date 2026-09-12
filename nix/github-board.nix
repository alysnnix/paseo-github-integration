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
  pname = "paseo-github-board";
  version = "0.5.0";

  # A file set rather than the directory: `node_modules`, the docs screenshots
  # and the lockfile have no business in the store path the daemon reads, and a
  # local `npm install` must not change this derivation's hash.
  src = lib.fileset.toSource {
    root = ../github-board;
    fileset = lib.fileset.unions [
      ../github-board/paseo-plugin.json
      ../github-board/package.json
      ../github-board/index.client.tsx
      ../github-board/index.server.ts
      ../github-board/client
      ../github-board/server
      ../github-board/shared
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
    if [ "$id" != "github-board" ]; then
      echo "paseo-plugin.json declares id '$id', expected 'github-board'" >&2
      exit 1
    fi

    mkdir -p "$out"
    cp -r . "$out/"

    runHook postInstall
  '';

  meta = {
    description = "Paseo sidebar board for GitHub issues, pull requests and discussions";
    homepage = "https://github.com/gpambrozio/paseo-plugins";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
})
