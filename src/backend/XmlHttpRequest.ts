import file_system = require('../core/file_system');
import file_index = require('../generic/file_index');
import buffer = require('../core/buffer');
import api_error = require('../core/api_error');
import file_flag = require('../core/file_flag');
import util = require('../core/util');
import file = require('../core/file');
import node_fs_stats = require('../core/node_fs_stats');
import preload_file = require('../generic/preload_file');
import browserfs = require('../core/browserfs');
import xhr = require('../generic/xhr');

var Buffer = buffer.Buffer;
var ApiError = api_error.ApiError;
var ErrorCode = api_error.ErrorCode;
var FileFlag = file_flag.FileFlag;
var ActionType = file_flag.ActionType;

/**
 * A simple filesystem backed by XmlHttpRequests.
 */
export class XmlHttpRequest extends file_system.BaseFileSystem implements file_system.FileSystem {
  private _index: file_index.FileIndex;
  public prefix_url: string;
  /**
   * Constructs the file system.
   * @param [String] listing_url The path to the JSON file index generated by
   *   tools/XHRIndexer.coffee. This can be relative to the current webpage URL
   *   or absolutely specified.
   * @param [String] prefix_url The url prefix to use for all web-server requests.
   */
  constructor(listing_url: string, prefix_url: string = '') {
    super();
    if (listing_url == null) {
      listing_url = 'index.json';
    }
    // prefix_url must end in a directory separator.
    if (prefix_url.length > 0 && prefix_url.charAt(prefix_url.length - 1) !== '/') {
      prefix_url = prefix_url + '/';
    }
    this.prefix_url = prefix_url;
    var listing = this._requestFileSync(listing_url, 'json');
    if (listing == null) {
      throw new Error("Unable to find listing at URL: " + listing_url);
    }
    this._index = file_index.FileIndex.from_listing(listing);
  }

  public empty(): void {
    this._index.fileIterator(function(file: node_fs_stats.Stats) {
      file.file_data = null;
    });
  }

  private getXhrPath(filePath: string): string {
    if (filePath.charAt(0) === '/') {
      filePath = filePath.slice(1);
    }
    return this.prefix_url + filePath;
  }

  /**
   * Only requests the HEAD content, for the file size.
   */
  public _requestFileSizeAsync(path: string, cb: (err: api_error.ApiError, size?: number) => void): void {
    xhr.getFileSizeAsync(this.getXhrPath(path), cb);
  }
  public _requestFileSizeSync(path: string): number {
    return xhr.getFileSizeSync(this.getXhrPath(path));
  }

  /**
   * Asynchronously download the given file.
   */
  private _requestFileAsync(p: string, type: 'buffer', cb: (err: api_error.ApiError, data?: NodeBuffer) => void): void;
  private _requestFileAsync(p: string, type: 'json', cb: (err: api_error.ApiError, data?: any) => void): void;
  private _requestFileAsync(p: string, type: string, cb: (err: api_error.ApiError, data?: any) => void): void;
  private _requestFileAsync(p: string, type: string, cb: (err: api_error.ApiError, data?: any) => void): void {
    xhr.asyncDownloadFile(this.getXhrPath(p), type, cb);
  }

  /**
   * Synchronously download the given file.
   */
  private _requestFileSync(p: string, type: 'buffer'): NodeBuffer;
  private _requestFileSync(p: string, type: 'json'): any;
  private _requestFileSync(p: string, type: string): any;
  private _requestFileSync(p: string, type: string): any {
    return xhr.syncDownloadFile(this.getXhrPath(p), type);
  }

  public getName(): string {
    return 'XmlHttpRequest';
  }

  public static isAvailable(): boolean {
    // @todo Older browsers use a different name for XHR, iirc.
    return typeof XMLHttpRequest !== "undefined" && XMLHttpRequest !== null;
  }

  public diskSpace(path: string, cb: (total: number, free: number) => void): void {
    // Read-only file system. We could calculate the total space, but that's not
    // important right now.
    cb(0, 0);
  }

  public isReadOnly(): boolean {
    return true;
  }

  public supportsLinks(): boolean {
    return false;
  }

  public supportsProps(): boolean {
    return false;
  }

  public supportsSynch(): boolean {
    return true;
  }

  /**
   * Special XHR function: Preload the given file into the index.
   * @param [String] path
   * @param [BrowserFS.Buffer] buffer
   */
  public preloadFile(path: string, buffer: NodeBuffer): void {
    var inode = <file_index.FileInode<node_fs_stats.Stats>> this._index.getInode(path);
    if (inode === null) {
      throw ApiError.ENOENT(path);
    }
    var stats = inode.getData();
    stats.size = buffer.length;
    stats.file_data = buffer;
  }

  public stat(path: string, isLstat: boolean, cb: (e: api_error.ApiError, stat?: node_fs_stats.Stats) => void): void {
    var inode = this._index.getInode(path);
    if (inode === null) {
      return cb(ApiError.ENOENT(path));
    }
    var stats: node_fs_stats.Stats;
    if (inode.isFile()) {
      stats = (<file_index.FileInode<node_fs_stats.Stats>> inode).getData();
      // At this point, a non-opened file will still have default stats from the listing.
      if (stats.size < 0) {
        this._requestFileSizeAsync(path, function(e: api_error.ApiError, size?: number) {
          if (e) {
            return cb(e);
          }
          stats.size = size;
          cb(null, stats.clone());
        });
      } else {
        cb(null, stats.clone());
      }
    } else {
      stats = (<file_index.DirInode> inode).getStats();
      cb(null, stats);
    }
  }

  public statSync(path: string, isLstat: boolean): node_fs_stats.Stats {
    var inode = this._index.getInode(path);
    if (inode === null) {
      throw ApiError.ENOENT(path);
    }
    var stats: node_fs_stats.Stats;
    if (inode.isFile()) {
      stats = (<file_index.FileInode<node_fs_stats.Stats>> inode).getData();
      // At this point, a non-opened file will still have default stats from the listing.
      if (stats.size < 0) {
        stats.size = this._requestFileSizeSync(path);
      }
    } else {
      stats = (<file_index.DirInode> inode).getStats();
    }
    return stats;
  }

  public open(path: string, flags: file_flag.FileFlag, mode: number, cb: (e: api_error.ApiError, file?: file.File) => void): void {
    // INVARIANT: You can't write to files on this file system.
    if (flags.isWriteable()) {
      return cb(new ApiError(ErrorCode.EPERM, path));
    }
    var _this = this;
    // Check if the path exists, and is a file.
    var inode = <file_index.FileInode<node_fs_stats.Stats>> this._index.getInode(path);
    if (inode === null) {
      return cb(ApiError.ENOENT(path));
    }
    if (inode.isDir()) {
      return cb(ApiError.EISDIR(path));
    }
    var stats = inode.getData();
    switch (flags.pathExistsAction()) {
      case ActionType.THROW_EXCEPTION:
      case ActionType.TRUNCATE_FILE:
        return cb(ApiError.EEXIST(path));
      case ActionType.NOP:
        // Use existing file contents.
        // XXX: Uh, this maintains the previously-used flag.
        if (stats.file_data != null) {
          return cb(null, new preload_file.NoSyncFile(_this, path, flags, stats.clone(), stats.file_data));
        }
        // @todo be lazier about actually requesting the file
        this._requestFileAsync(path, 'buffer', function(err: api_error.ApiError, buffer?: NodeBuffer) {
          if (err) {
            return cb(err);
          }
          // we don't initially have file sizes
          stats.size = buffer.length;
          stats.file_data = buffer;
          return cb(null, new preload_file.NoSyncFile(_this, path, flags, stats.clone(), buffer));
        });
        break;
      default:
        return cb(new ApiError(ErrorCode.EINVAL, 'Invalid FileMode object.'));
    }
  }

  public openSync(path: string, flags: file_flag.FileFlag, mode: number): file.File {
    // INVARIANT: You can't write to files on this file system.
    if (flags.isWriteable()) {
      throw new ApiError(ErrorCode.EPERM, path);
    }
    // Check if the path exists, and is a file.
    var inode = <file_index.FileInode<node_fs_stats.Stats>> this._index.getInode(path);
    if (inode === null) {
      throw ApiError.ENOENT(path);
    }
    if (inode.isDir()) {
      throw ApiError.EISDIR(path);
    }
    var stats = inode.getData();
    switch (flags.pathExistsAction()) {
      case ActionType.THROW_EXCEPTION:
      case ActionType.TRUNCATE_FILE:
        throw ApiError.EEXIST(path);
      case ActionType.NOP:
        // Use existing file contents.
        // XXX: Uh, this maintains the previously-used flag.
        if (stats.file_data != null) {
          return new preload_file.NoSyncFile(this, path, flags, stats.clone(), stats.file_data);
        }
        // @todo be lazier about actually requesting the file
        var buffer = this._requestFileSync(path, 'buffer');
        // we don't initially have file sizes
        stats.size = buffer.length;
        stats.file_data = buffer;
        return new preload_file.NoSyncFile(this, path, flags, stats.clone(), buffer);
      default:
        throw new ApiError(ErrorCode.EINVAL, 'Invalid FileMode object.');
    }
  }

  public readdir(path: string, cb: (e: api_error.ApiError, listing?: string[]) => void): void {
    try {
      cb(null, this.readdirSync(path));
    } catch (e) {
      cb(e);
    }
  }

  public readdirSync(path: string): string[] {
    // Check if it exists.
    var inode = this._index.getInode(path);
    if (inode === null) {
      throw ApiError.ENOENT(path);
    } else if (inode.isFile()) {
      throw ApiError.ENOTDIR(path);
    }
    return (<file_index.DirInode> inode).getListing();
  }

  /**
   * We have the entire file as a buffer; optimize readFile.
   */
  public readFile(fname: string, encoding: string, flag: file_flag.FileFlag, cb: (err: api_error.ApiError, data?: any) => void): void {
    // Wrap cb in file closing code.
    var oldCb = cb;
    // Get file.
    this.open(fname, flag, 0x1a4, function(err: api_error.ApiError, fd?: file.File) {
      if (err) {
        return cb(err);
      }
      cb = function(err: api_error.ApiError, arg?: buffer.Buffer) {
        fd.close(function(err2) {
          if (err == null) {
            err = err2;
          }
          return oldCb(err, arg);
        });
      };
      var fdCast = <preload_file.NoSyncFile> fd;
      var fdBuff = <buffer.Buffer> fdCast.getBuffer();
      if (encoding === null) {
        if (fdBuff.length > 0) {
          return cb(err, fdBuff.sliceCopy());
        } else {
          return cb(err, new buffer.Buffer(0));
        }
      }
      try {
        cb(null, fdBuff.toString(encoding));
      } catch (e) {
        cb(e);
      }
    });
  }

  /**
   * Specially-optimized readfile.
   */
  public readFileSync(fname: string, encoding: string, flag: file_flag.FileFlag): any {
    // Get file.
    var fd = this.openSync(fname, flag, 0x1a4);
    try {
      var fdCast = <preload_file.NoSyncFile> fd;
      var fdBuff = <buffer.Buffer> fdCast.getBuffer();
      if (encoding === null) {
        if (fdBuff.length > 0) {
          return fdBuff.sliceCopy();
        } else {
          return new buffer.Buffer(0);
        }
      }
      return fdBuff.toString(encoding);
    } finally {
      fd.closeSync();
    }
  }
}

browserfs.registerFileSystem('XmlHttpRequest', XmlHttpRequest);
