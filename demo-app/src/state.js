export function createStore(initialState) {
  let state = initialState;
  const listeners = [];

  return {
    getState: () => state,
    setState: (newState) => {
      state = Object.assign({}, state, newState);
      listeners.forEach(fn => fn(state));
      return state;
    },
    subscribe: (fn) => {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    }
  };
}
