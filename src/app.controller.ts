import { Controller } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}
  
  // (Hello World를 반환하던 @Get() 라우터를 삭제했습니다)
}