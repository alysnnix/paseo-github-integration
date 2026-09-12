{
  description = "The GitHub integration plugin for Paseo, packaged for Nix";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        github-integration = pkgs.callPackage ./nix/plugin.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.github-integration;
      });

      # The daemon reads the plugin straight from the store path, so a build is
      # the whole check there is: nothing is compiled here, and the typecheck
      # needs the npm dev tree, which lives with a clone rather than with this
      # flake. `npm run typecheck` at the repository root is still the gate for
      # a source change.
      checks = forAllSystems (pkgs: {
        github-integration = self.packages.${pkgs.stdenv.hostPlatform.system}.github-integration;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
