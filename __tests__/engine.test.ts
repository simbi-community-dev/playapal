import { adaptOpSqliteConnection } from '../src/events/engine';

describe('op-sqlite storage seam', () => {
  test('uses executeSync and restores quick-sqlite row accessors', () => {
    const execute = jest.fn(() => Promise.resolve({ rows: [{ id: 99 }] }));
    const executeSync = jest.fn(() => ({ rows: [{ id: 7 }, { id: 8 }] }));
    const raw = { execute, executeSync };
    const conn = adaptOpSqliteConnection(raw);

    const out = conn.execute('SELECT id FROM facts WHERE type = ?', ['person']);

    expect(executeSync).toHaveBeenCalledWith(
      'SELECT id FROM facts WHERE type = ?',
      ['person'],
    );
    expect(execute).not.toHaveBeenCalled();
    expect(out.rows?._array).toEqual([{ id: 7 }, { id: 8 }]);
    expect(out.rows?.length).toBe(2);
    expect(out.rows?.item(1)).toEqual({ id: 8 });
  });

  test('normalizes writes and empty selects to an empty row collection', () => {
    const conn = adaptOpSqliteConnection({
      executeSync: () => ({ rows: [] }),
    });

    const out = conn.execute('UPDATE facts SET name = ?', ['Rook']);

    expect(out.rows?._array).toEqual([]);
    expect(out.rows?.length).toBe(0);
    expect(out.rows?.item(0)).toBeUndefined();
  });
});
