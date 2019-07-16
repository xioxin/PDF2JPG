import {ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnInit, ViewChild} from '@angular/core';
import {ElectronService} from '../../providers/electron.service';
import { default as PQueue } from 'p-queue';
import {MatDialog, MatIconRegistry} from '@angular/material';
import {DomSanitizer} from '@angular/platform-browser';
import {NotFoundGsComponent} from '../not-found-gs/not-found-gs.component';
import {app} from 'electron';

interface PdfTask {
  path: string;
  name: string;
  pages: number;
  status: number;
  progress: {
    index: number,
    complete: boolean, // 完成
    inspection: boolean, // 文件是否检查
    existence: boolean, // 文件是否存在
  }[];
  log: string;
}

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent implements OnInit {

  constructor(
    private es: ElectronService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
    private matIcon: MatIconRegistry,
    private sanitizer: DomSanitizer,
    public dialog: MatDialog
  ) {

    console.log('__dirname', __dirname);
    console.log('__filename', __filename);
    console.log('app.getAppPath()', this.es.remote.app.getAppPath());

    const os = this.es.remote.require('os');
    this.cpuSize = os.cpus().length || 1;
    this.concurrencyChange(this.cpuSize);
    this.platform = os.platform();

    this.getBinPath().then(v => {
      this.cdr.markForCheck();
    });
  }

  browserWindow: any;

  @ViewChild('list', {static: true}) list: ElementRef ;



  cpuSize = 1;
  binPath = '';
  platform = '';
  fileListPath: string[] = [];
  fileList: PdfTask[] = [];
  dpi = 300;
  quality = 80;
  queue: PQueue;
  targetDir = '';
  execSet = new Set();
  concurrency = 4;

  setTargetDir() {
    const { dialog } = this.es.remote.require('electron');
    const path = dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (path && path[0]) {
      this.zone.run(() => {
        this.targetDir = path[0];
        console.log('this.targetDir', this.targetDir);
        this.cdr.markForCheck();
      });
    }
  }

  concurrencyChange(concurrency) {
    this.concurrency = concurrency;
    if (this.queue) {
      this.queue.concurrency = concurrency;
    }
  }

  show() {

  }
  ngOnInit() {

  }

  async getBinPath() {

    const os = this.es.remote.require('os');
    const possibleGS: string[] = [
      '/usr/local/bin/gs',
      '/usr/bin/gs'
    ];

    const access = (accessPath: string): Promise<boolean> => {
      return new Promise(async (resolve) => {
        this.es.fs.access(accessPath, (err) => {
          if (err) {
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });
    };

    const path = this.es.remote.require('path');
    if (this.platform === 'win32') {
      const x = os.arch() === 'x64' ? '64' : '32';
      if (this.es.remote.app.isPackaged) {
        this.binPath = path.join(path.dirname(this.es.remote.app.getAppPath()), 'bin', 'win', `gswin${x}c.exe`);
      } else {
        this.binPath = path.join(this.es.remote.app.getAppPath(), 'src', 'bin', 'win', `gswin${x}c.exe`);
      }
    } else {

      for (const gs of possibleGS) {
        if (await access(gs)) {
          this.binPath = gs;
          continue;
        }
      }
      if (!this.binPath) {

        const dialogRef = this.dialog.open(NotFoundGsComponent, {
          width: '250px',
          data: {}
        });

        dialogRef.afterClosed().subscribe(result => {
          console.log('The dialog was closed', result);
        });

      }
    }


  }

  addFiles() {
    const { dialog } = this.es.remote.require('electron');
    const path = this.es.remote.require('path');
    const pdfmeta = this.es.remote.require('pdfmeta');

    console.log('path', path);
    // tslint:disable-next-line:max-line-length
    this.fileListPath = (dialog.showOpenDialog({
      filters: [
        { name: 'PDF', extensions: ['pdf'] },
      ],
      // browserWindow: this.es.remote.getCurrentWindow(),
      properties: ['openFile', 'multiSelections'],
    }) || []).filter(v => path.extname(v).toLowerCase() === '.pdf');
    if (this.fileListPath[0]) {
      this.zone.run(() => {
        this.targetDir = path.dirname(this.fileListPath[0]) + path.sep + 'image';
        console.log('this.targetDir', this.targetDir);
        this.cdr.markForCheck();
      });
    }
    Promise.all(this.fileListPath.map(v => pdfmeta.getInfo(v))).then(fileList => {
      this.fileList = fileList.map((v, i) => {
        return {
          path: this.fileListPath[i],
          name: path.basename(this.fileListPath[i]),
          pages: v.pages,
          log: '',
          status: 0,
          progress: new Array(v.pages).fill(1).map((v2, i2) => ({
            index: i2,
            complete: false,
            inspection: false,
            existence: false,
          }))
        };
      });
      this.cdr.markForCheck();
    });

  }

  dragenter(e: DragEvent) {
    console.log('e', e);
    return true;
    // e.preventDefault();
  }

  drag(e: DragEvent) {
    e.preventDefault();
    console.log('e drag', e);
  }

  gsGo(task: PdfTask): Promise<any> {
    const { exec } = this.es.childProcess;
    const fs = this.es.fs;
    const path = this.es.remote.require('path');
    const iconv = this.es.remote.require('iconv-lite');
    const {sh} = this.es.remote.require('puka');
    task.status = 1;
    const el: HTMLElement = this.list.nativeElement;

    if (this.queue) {
      el.scrollTop = ((this.fileList.length - this.queue.size) * 56) - el.offsetHeight;
    }

    return new Promise(async (rootResolve, rootReject) => {
      await new Promise(async (resolve) => {
        fs.access(this.targetDir, (err) => {
          if (err) {
            fs.mkdir(this.targetDir, () => {
              resolve();
            });
          } else {
            resolve();
          }
        });
      });


      const name = task.name.split('.')[0] || task.name || 'noname';
      const sOutputFile = `${this.targetDir}${path.sep}${name}-%04d.jpg`;
      const f = task.path;

      const args = [
        this.binPath,
        '-sDEVICE=jpeg',
        sh`-sOutputFile=${sOutputFile}`,
        `-r${this.dpi || 300}`,
        '-dNOPAUSE',
        '-dFirstPage=1',
        '-dLastPage=9999',
        `-dJPEGQ${this.quality || 80}`,
        '-dGraphicsAlphaBits=2',
        '-dTextAlphaBits=2',
        `-dNumRenderingThreads=${4}`,
        '-dBufferSpace=300000000',
        '-dBandBufferSpace=300000000',
        '-c',
        '300000000',
        'setvmthreshold',
        sh`-f ${f}`,
        '-c quit',
      ];

      const command =  args.join(' ');
      console.log(command);
      const gsTask = exec(command, {
        encoding: 'buffer'
      });
      this.execSet.add(gsTask);

      gsTask.stdout.on('data', (data: string) => {
        data = iconv.decode(data, 'cp936');
        task.log += data;
        this.zone.run(() => {
          data.split('\n').forEach(line => {
            const m = (line || '').match(/Page ([0-9]+)/);
            if (m && m[1]) {
              let index = parseInt(m[1], 10);
              if (index) {
                index--;
                if (task.progress[index]) {
                  task.progress[index].complete = true;
                }
              }
            }
          });
          this.cdr.markForCheck();
        });
        this.es.remote.getCurrentWindow().setProgressBar(
          this.getProgress(),
          {
            mode: 'normal'
          }
        );
        console.log('standard output:\n' + data);
      });

      gsTask.stderr.on('data', (data) => {
        data = iconv.decode(data, 'cp936');
        task.log += data;
        this.cdr.markForCheck();
        console.log('standard error output:\n' + data);
      });

      gsTask.on('exit', (code, signal) => {
        this.zone.run(() => {
          this.execSet.delete(gsTask);
          this.cdr.markForCheck();
        });

        task.status = code === 0 ? 2 : -1;
        console.log('child process eixt ,exit:' + code);
        this.cdr.markForCheck();
        rootResolve();

        if (this.execSet.size === 0 && this.queue.size === 0) {
          this.zone.run(() => {
            this.queue = undefined;
            this.done();
            this.cdr.markForCheck();
          });
          setTimeout(() => {
            this.es.remote.getCurrentWindow().setProgressBar(
              0,
              {
                mode: 'none'
              }
            );
          }, 2000);
        }

      });

    });
  }

  done() {
    const { shell } = this.es.remote.require('electron');
    const path = this.es.remote.require('path');
    shell.showItemInFolder(this.targetDir + path.sep);
  }

  start() {

    this.queue = new PQueue({concurrency: this.concurrency});
    this.queue.onIdle().then(v => {
      console.log('onIdle');
    });
    this.queue.onEmpty().then(v => {
      console.log('onEmpty');
    });
    this.fileList.forEach(v => {
      if (v.status >= 2) { return; }
      v.progress.forEach(p => {
        p.complete = false;
        p.existence = false;
        p.inspection = false;
      });
      this.queue.add(() => this.gsGo(v));
    });
  }

  stop() {
    if (this.queue) {
      this.queue.pause();
      this.queue.clear();
      this.execSet.forEach(gsTask => {
        gsTask.kill('SIGTERM');
      });
      this.queue = undefined;
    }
  }

  getProgress() {
    let count = 0;
    let complete = 0;

    this.fileList.forEach(v => {
      count += v.pages;
      complete += v.progress.filter(v2 => v2.complete).length;
    });

    return complete / count;
  }


  exit() {
    this.es.remote.getCurrentWindow().destroy();
  }
  min() {
    this.es.remote.getCurrentWindow().minimize();
  }

  get isMax(): boolean {
    return this.es.remote.getCurrentWindow().isMaximized();
  }
  max() {
    if (!this.isMax) {
      this.es.remote.getCurrentWindow().maximize();
    } else {
      this.es.remote.getCurrentWindow().unmaximize();
    }
  }

}
