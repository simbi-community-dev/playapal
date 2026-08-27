import React from 'react';
import { Alert, Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import { CampScreen } from '../src/screens/CampScreen';
import { CampBeamError, type BoardPost } from '../src/camp/campBoard';

const mockListCampBoard = jest.fn<BoardPost[], []>();
const mockSetPostDone = jest.fn();
const mockRebuildFtsAfterCommit = jest.fn();

// IA adaptation: this branch's CampScreen ships the beam-as-file flow
// (writeFile + share of a .playapal file), which imports rn-fs at module
// level; the ESM build cannot be parsed by jest, so the surface is inert
// here the same way beamIngress mocks it.
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  ExternalDirectoryPath: '/ext',
  exists: jest.fn(async () => false),
  mkdir: jest.fn(async () => {}),
  readFile: jest.fn(async () => ''),
  writeFile: jest.fn(async () => {}),
  unlink: jest.fn(async () => {}),
}));
jest.mock('react-native-share', () => ({ default: { open: jest.fn(async () => ({})) } }), { virtual: true });

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  types: { allFiles: '*/*' },
}));

jest.mock('../src/events/db', () => ({
  // Any read this screen makes against the mock answers "empty", never
  // undefined — this branch's CampScreen also probes lineage data and the
  // pack list at mount (IA adaptation).
  getDb: () => ({
    execute: jest.fn(() => ({
      rows: { _array: [], length: 0, item: () => null },
    })),
  }),
  listPacks: () => [],
  getSetting: () => null,
  setSetting: jest.fn(),
  rebuildFtsIndexes: jest.fn(),
  rebuildFtsAfterCommit: (...args: unknown[]) => mockRebuildFtsAfterCommit(...args),
}));

jest.mock('../src/camp/campBoard', () => {
  const actual = jest.requireActual('../src/camp/campBoard');
  return {
    ...actual,
    getCampIdentity: () => ({
      writerId: 'writer-1',
      authorName: 'River',
      passphrase: '',
      campId: '',
      keyId: '',
    }),
    listCampBoard: () => mockListCampBoard(),
    setPostDone: (...args: unknown[]) => mockSetPostDone(...args),
  };
});

const post: BoardPost = {
  id: 'post-1',
  writer_id: 'writer-1',
  author_name: 'River',
  type: 'need',
  text: 'Need a tube',
  ref_id: null,
  ref_writer_id: null,
  // RELATIVE, not fixed (2026-08-26: a fixed date time-bombed this suite —
  // the board's Fresh-window filter aged the fixture out at a UTC midnight,
  // the 'Met' button vanished on every tree at once, and a green-for-months
  // test went red mid-release-train with no code change anywhere).
  created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  done: false,
  pack_id: 'camp-board-local',
  fork: false,
};

describe('CampScreen post status errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListCampBoard.mockReturnValueOnce([post]).mockReturnValue([]);
    mockSetPostDone.mockImplementation(() => {
      throw new CampBeamError('That post is no longer on this board.');
    });
  });

  it('surfaces a stale status target and refreshes without rebuilding FTS', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<CampScreen onOpenCompass={() => {}} />);
    });
    const label = tree!.root
      .findAllByType(Text)
      .find(node => node.props.children === 'Met');
    let button = label?.parent;
    while (button && typeof button.props.onPress !== 'function') {
      button = button.parent;
    }
    expect(button).toBeDefined();

    expect(() => {
      act(() => {
        button!.props.onPress();
      });
    }).not.toThrow();

    expect(mockSetPostDone).toHaveBeenCalledWith(expect.anything(), 'post-1', true);
    expect(mockRebuildFtsAfterCommit).not.toHaveBeenCalled();
    expect(mockListCampBoard).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledWith(
      'Post unchanged',
      'That post is no longer on this board.',
    );
    alert.mockRestore();
  });
});
