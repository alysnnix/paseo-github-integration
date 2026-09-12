{
  description = "Paseo plugins, packaged for Nix";

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
        github-board = pkgs.callPackage ./nix/github-board.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.github-board;
      });

      # The daemon reads the plugin straight from the store path, so a build is
      # the whole check there is: nothing is compiled here, and the typecheck
      # needs the npm dev tree, which lives with a clone rather than with this
      # flake. `npm run typecheck` in the plugin directory is still the gate for
      # a source change.
      checks = forAllSystems (pkgs: {
        github-board = self.packages.${pkgs.stdenv.hostPlatform.system}.github-board;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
