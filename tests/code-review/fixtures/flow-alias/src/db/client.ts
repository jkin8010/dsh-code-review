export const db = {
  insert(table: string, value: unknown) {
    return { table, value };
  },
};
