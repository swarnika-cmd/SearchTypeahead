import { debounce } from '../frontend/src/utils/debounce';

describe('Debounce Utility Function', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should delay function execution', () => {
    const callback = jest.fn();
    const debounced = debounce(callback, 200);

    debounced();
    expect(callback).not.toHaveBeenCalled();

    // Fast-forward time
    jest.advanceTimersByTime(100);
    expect(callback).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('should execute only once for multiple sequential calls', () => {
    const callback = jest.fn();
    const debounced = debounce(callback, 200);

    debounced('first');
    debounced('second');
    debounced('third');

    expect(callback).not.toHaveBeenCalled();

    jest.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('third');
  });

  test('should pass parameters correctly', () => {
    const callback = jest.fn();
    const debounced = debounce(callback, 200);

    debounced('hello', 123);
    jest.advanceTimersByTime(200);

    expect(callback).toHaveBeenCalledWith('hello', 123);
  });
});
