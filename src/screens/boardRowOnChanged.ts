/** The board pack row's onChanged, a pure module so its WIRING is testable
 * from any suite: a board mute must refresh both the pack rows and the
 * rendered board (audit round 6e — callback-relocation mutant). */
export const boardRowOnChanged =
  (refreshPacks: () => void, refreshBoard: () => void) => (): void => {
    refreshPacks();
    refreshBoard();
  };
